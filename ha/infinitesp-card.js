/*
 * InfinitESP Card - a polished single custom card for Home Assistant.
 *
 * Sections:
 *   1. Outdoor Unit : outdoor temp, coil temp, compressor stage, line voltage.
 *   2. Air Handler  : airflow (CFM), blower (RPM), and a DERIVED static
 *                     pressure estimate (static = k * CFM^exp, in. w.c.).
 *   3. Fault History: color-coded (red = FAULT, amber = notice), parsed from the
 *                     fault_1..fault_10 sensors, with code descriptions.
 *
 * No build step / no dependencies. Drop in <config>/www/, register as a
 * `module` resource, then use `type: custom:infinitesp-card`.
 */

const TEMP_C_TO_F = (c) => (c * 9) / 5 + 32;

// Selectable history ranges for the expandable metric chart.
const RANGE_HOURS = { "1h": 1, "6h": 6, "24h": 24, "3d": 72, "7d": 168 };

// Fault code -> description. Confirmed against the thermostat where noted;
// others are best-effort from Carrier Infinity / Bryant Evolution references.
// Override or extend per-card via config `fault_codes: { 47: "..." }`.
const FAULT_CODES = {
  16: "Communication Error",           // zone-controller comm (notice)
  47: "No 230V at Unit",               // ODU not receiving 230V (breaker/disconnect/contactor)
  171: "Smart Sensor Zone 2 Comm Fault", // confirmed on thermostat
  178: "Indoor Unit Comm Fault",
  179: "Outdoor Unit Comm Fault",
  180: "Zone / Smart Sensor Comm Fault",
  186: "SAM Communication Fault",      // confirmed on thermostat
};

// Fault source abbreviations -> human names (for tooltips).
const SRC_NAMES = {
  UI: "Thermostat (UI)",
  IDU: "Indoor unit / furnace",
  ODU: "Outdoor unit",
  ZC: "Zone controller",
};

// Home Assistant's ESPHome integration builds every entity id as
//   sensor.<node_name_slug>_<sensor_name_slug>
// where the suffix is the firmware sensor's `name:` slugified. Given just the
// ESPHome node name (e.g. "infinitesp-dev") the card can auto-derive every
// entity id from this map of card-key -> firmware name slug. These slugs match
// the `name:` values in infinitesp.yaml and must stay in sync with it.
const FEATURE_SUFFIX = {
  outdoor_temp: "odu_outdoor_temp",
  coil_temp: "odu_coil_temp",
  stage: "odu_stage",
  line_voltage: "odu_line_voltage",
  airflow: "airflow_cfm",
  blower_rpm: "blower_rpm",
  blower_watts: "blower_power",
  static_pressure: "static_pressure",
  odu_model: "outdoor_unit_model",
  furnace_model: "furnace_model",
  zoning_model: "zoning_board_model",
};

// Slugify a name/node the same way HA does: lowercase, every run of
// non-alphanumeric characters -> single "_", trimmed of leading/trailing "_".
const SLUG = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

// Feature registry for the Outdoor Unit (odu) and Air Handler (idu) sections.
// Each key is both the entity key (see FEATURE_SUFFIX) and the feature id used
// in the `sections:` config. `kind` selects how the tile renders.
const FEATURES = {
  outdoor_temp: { section: "odu", label: "Outdoor Temp", icon: "mdi:thermometer", kind: "temp" },
  coil_temp: { section: "odu", label: "Coil Temp", icon: "mdi:coolant-temperature", kind: "temp" },
  stage: { section: "odu", label: "Stage", icon: "mdi:stairs", kind: "stage" },
  line_voltage: { section: "odu", label: "Line Voltage", icon: "mdi:flash", kind: "num", unit: "V", digits: 0 },
  airflow: { section: "idu", label: "Airflow", icon: "mdi:air-filter", kind: "num", unit: "CFM", digits: 0 },
  blower_rpm: { section: "idu", label: "Blower", icon: "mdi:fan", kind: "num", unit: "RPM", digits: 0 },
  blower_watts: { section: "idu", label: "Blower Power", icon: "mdi:lightning-bolt", kind: "num", unit: "W", digits: 0 },
  static_pressure: { section: "idu", label: "Static Pressure", icon: "mdi:gauge", kind: "static", unit: "in wc", digits: 2, accent: "blue" },
  system_mode: { section: "idu", label: "System Mode", icon: "mdi:hvac", kind: "select" },
};

// Per-zone metrics for the Zoning section (order is user-configurable too).
const ZONE_METRICS = {
  temp: { label: "Temp", icon: "mdi:thermometer" },
  humidity: { label: "Humidity", icon: "mdi:water-percent" },
  damper: { label: "Damper Open", icon: "mdi:valve" },
  heat_target: { label: "Heat To", icon: "mdi:fire" },
  cool_target: { label: "Cool To", icon: "mdi:snowflake" },
  fan_mode: { label: "Fan", icon: "mdi:fan", kind: "select" },
  profile: { label: "Profile", icon: "mdi:calendar-clock", kind: "select" },
};

// Default feature order per section (used when `sections:` is not configured).
const DEFAULT_SECTIONS = {
  odu: ["outdoor_temp", "coil_temp", "stage", "line_voltage"],
  idu: ["airflow", "blower_rpm", "blower_watts", "static_pressure", "system_mode"],
  zoning: ["temp", "humidity", "damper", "heat_target", "cool_target", "fan_mode", "profile"],
};

// Friendlier labels for select option values, per control context (the option
// value "auto" means "Heat/Cool" for system mode but plain "Auto" for a fan).
// Fallback: Title-cased slug (so med->Med, low->Low, hold->Hold need no entry).
const OPT_LABELS = {
  system_mode: { auto: "Heat/Cool", emergency_heat: "Em. Heat" },
  profile: { schedule: "Per Schedule" },
};
const OPT_LABEL = (v, ctx) => (OPT_LABELS[ctx] && OPT_LABELS[ctx][v]) || TITLE(v);

// Valid feature keys for a section (odu/idu from FEATURES, zoning from metrics).
const SECTION_KEYS = (section) =>
  section === "zoning"
    ? Object.keys(ZONE_METRICS)
    : Object.keys(FEATURES).filter((k) => FEATURES[k].section === section);

// Title-case a slug: "floor_1_2" -> "Floor 1 2".
const TITLE = (s) =>
  String(s || "")
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

// Entity ids on a device: registry (hass.entities) when a device_id is known,
// otherwise fall back to matching the node-name prefix against hass.states.
const DEVICE_ENTITY_IDS = (hass, deviceId, prefix, domain) => {
  if (!hass) return [];
  const dot = domain ? domain + "." : "";
  if (deviceId && hass.entities) {
    return Object.keys(hass.entities).filter(
      (id) => hass.entities[id].device_id === deviceId && (!domain || id.startsWith(dot))
    );
  }
  if (prefix && hass.states) {
    return Object.keys(hass.states).filter((id) =>
      domain ? id.startsWith(`${domain}.${prefix}_`) : id.startsWith(`sensor.${prefix}_`)
    );
  }
  return [];
};

// Discover zones from Home Assistant. Every zone is an HA SUB-DEVICE (created by
// the firmware `zones:` map) carrying a climate.<zoneslug>_climate entity and the
// per-zone temp/humidity/damper/setpoint/select entities. We enumerate the hub's
// sub-devices; ZONE_ENTITY_IDS then resolves each metric by the zone slug.
// Falls back to the legacy main-node layout (climate.<node>_<zone>_climate).
const discoverZones = (hass, deviceId, prefix) => {
  if (!hass || !hass.entities) return [];
  // Resolve the hub device id: explicit, else from a main-node entity by prefix.
  let hubId = deviceId;
  if (!hubId && prefix) {
    const anchor = Object.keys(hass.entities).find(
      (id) => id.startsWith(`sensor.${prefix}_`) && hass.entities[id].device_id
    );
    if (anchor) hubId = hass.entities[anchor].device_id;
  }
  const climateOf = (did) =>
    Object.keys(hass.entities).find(
      (id) =>
        hass.entities[id].device_id === did &&
        id.startsWith("climate.") &&
        id.endsWith("_climate")
    );
  // Sub-devices with a climate entity. Prefer those linked to our hub
  // (via_device_id); if that yields none (or the hub is unknown), accept any.
  const subs = hass.devices ? Object.keys(hass.devices) : [];
  const withClimate = subs
    .filter((did) => did !== hubId && climateOf(did))
    .map((did) => ({ did, d: hass.devices[did] }));
  let zones = withClimate
    .filter(({ d }) => !hubId || (d && d.via_device_id === hubId))
    .map(({ d }) => ({ name: ((d.name_by_user || d.name) || "").trim() }))
    .filter((z) => z.name);
  // If the via_device_id link isn't populated, fall back to any non-hub device
  // that carries a climate.*_climate entity (almost certainly a zone sub-device).
  if (!zones.length && withClimate.length) {
    zones = withClimate
      .map(({ d }) => ({ name: ((d.name_by_user || d.name) || "").trim() }))
      .filter((z) => z.name);
  }
  if (zones.length) return zones;

  // Legacy fallback: main-node climates (climate.<prefix>_<zone>_climate).
  const climates = DEVICE_ENTITY_IDS(hass, deviceId, prefix, "climate").filter((id) =>
    id.endsWith("_climate")
  );
  const has = (id) => id && hass.states && hass.states[id];
  return climates
    .map((cid) => {
      const stem = cid.slice("climate.".length).replace(/_climate$/, ""); // node_zone
      const fn = hass.states[cid] && hass.states[cid].attributes && hass.states[cid].attributes.friendly_name;
      const rel = prefix && stem.startsWith(prefix + "_") ? stem.slice(prefix.length + 1) : stem;
      const name = fn ? fn.replace(/\s*climate$/i, "").trim() : TITLE(rel);
      const sensor = (suffix) => (has(`sensor.${stem}_${suffix}`) ? `sensor.${stem}_${suffix}` : null);
      const damper = sensor("damper_position") || (has(`cover.${stem}_damper`) ? `cover.${stem}_damper` : null);
      return { name, temp: sensor("temperature"), humidity: sensor("humidity"), damper };
    })
    .filter((z) => z.temp || z.humidity || z.damper);
};

// Resolve a zone's metric entity ids. Explicit overrides (temp/humidity/damper)
// win; otherwise deduce from the node prefix + slugified zone name — the same
// stem ESPHome uses (climate.<prefix>_<zone>_climate -> sensor.<prefix>_<zone>_*).
// Damper prefers the numeric _damper_position sensor, falling back to the cover.
const ZONE_ENTITY_IDS = (hass, zone, prefix) => {
  const slug = SLUG(zone.name || "");
  const stem = prefix ? `${prefix}_${slug}` : slug;
  const has = (id) => id && hass && hass.states && hass.states[id];
  // The zone's HA sub-device (created by the firmware `zones:` map). Found by
  // matching its name to the zone name. This lets us resolve sub-device entities
  // via the registry even when HA kept a LEGACY entity_id from an earlier name
  // (e.g. a fan_mode that was once "Zone 1 Fan Mode" -> select.<node>_zone_1_fan_mode)
  // instead of the current slug convention (select.<zoneslug>_fan_mode).
  let subDevId = null;
  if (hass && hass.devices && slug) {
    for (const did of Object.keys(hass.devices)) {
      const d = hass.devices[did];
      if (SLUG((d && (d.name_by_user || d.name)) || "") === slug) {
        subDevId = did;
        break;
      }
    }
  }
  // Find a sub-device entity of `domain` whose object_id is (or ends with) metric.
  const regId = (domain, metric) => {
    if (!subDevId || !hass.entities) return "";
    const pfx = domain + ".";
    return (
      Object.keys(hass.entities).find((id) => {
        if (hass.entities[id].device_id !== subDevId || !id.startsWith(pfx)) return false;
        const obj = id.slice(pfx.length);
        return obj === metric || obj.endsWith("_" + metric);
      }) || ""
    );
  };
  // Resolve a per-zone entity id for `domain`/`metric`. All per-zone entities now
  // live on the zone HA sub-device, so the entity_id is the zone slug + object_id
  // (e.g. sensor.floor_3_temperature, climate.floor_3_climate). Resolution order:
  //   1. sub-device slug id (the current convention)
  //   2. entity registry on the sub-device (handles legacy/renamed entity_ids)
  //   3. legacy node-prefixed stem (entities still on the main node)
  const mid = (domain, metric) => {
    const bySlug = slug ? `${domain}.${slug}_${metric}` : "";
    if (has(bySlug)) return bySlug;
    const reg = regId(domain, metric);
    if (reg) return reg;
    const byStem = stem ? `${domain}.${stem}_${metric}` : "";
    return has(byStem) ? byStem : bySlug || byStem;
  };
  // Damper: prefer the numeric _damper_position sensor (graphable), else the cover
  // (object_id "cover" now; "damper" was the old name — kept as a legacy fallback).
  let damper = zone.damper;
  if (!damper) {
    const s = mid("sensor", "damper_position");
    const c = mid("cover", "cover");
    const cLegacy = mid("cover", "damper");
    damper = has(s) ? s : has(c) ? c : has(cLegacy) ? cLegacy : s || c || cLegacy;
  }
  return {
    name: zone.name,
    temp: zone.temp || mid("sensor", "temperature"),
    humidity: zone.humidity || mid("sensor", "humidity"),
    damper: damper || "",
    heat_target: zone.heat_target || mid("number", "heat_target"),
    cool_target: zone.cool_target || mid("number", "cool_target"),
    fan_mode: zone.fan_mode || mid("select", "fan_mode"),
    profile: zone.profile || mid("select", "profile"),
  };
};

class InfinitespCard extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign(
      {
        title: "Carrier Infinity",
        // Static-pressure estimate, best-to-worst:
        //  1. Physical watts model  SP = static_watts_k * BlowerWatts / CFM
        //     (air power = efficiency * motor power). Fit exactly to two points:
        //     0.54@228W/863CFM and 0.66@378.5W/1175CFM -> K=2.046 (eta~24%).
        //     Used when a blower_watts entity is configured.
        //  2. RPM+CFM power law  SP = static_k * RPM^static_rpm_exp * CFM^static_cfm_exp
        //  3. CFM-only  SP = static_k_cfm * CFM^static_cfm_only_exp
        static_watts_k: 2.046,
        static_k: 2.7415e-5,
        static_rpm_exp: 0.4461,
        static_cfm_exp: 1.0256,
        static_k_cfm: 6.13e-5,
        static_cfm_only_exp: 1.34,
        temperature_unit: "F", // "F" or "C" for the temperature tiles
        // Per-fault link. {code} and {desc} are substituted (URL-encoded).
        fault_link: "https://www.google.com/search?q=Carrier+Infinity+fault+code+{code}",
        entities: {},
        faults: [],
        fault_codes: {},
        zones: [],
      },
      config
    );
    // Preserve the user's raw config so re-resolution (once hass/registry is
    // available) never compounds derived values.
    this._rawEntities = Object.assign({}, config.entities || {});
    this._rawFaults = (config.faults || []).slice();
    this._rawZones = (config.zones || []).slice();
    this._prefix = "";
    this._registryResolved = false;
    this._zonesResolved = false;
    this._resolve();
    // merge user code overrides on top of the built-ins
    this._codes = Object.assign({}, FAULT_CODES, this._config.fault_codes || {});
    this._sig = null;
    // Expandable-chart state (preserved across re-renders).
    if (!this._chart) this._chart = { entity: null, range: "24h", label: "" };
    this._histCache = this._histCache || {};
    this._chartToken = this._chartToken || 0;
  }

  // Resolve entity ids from (in priority order) explicit overrides, an ESPHome
  // `device_id` (via the entity registry), or a `device` node-name string.
  // Idempotent — always rebuilds from the stored raw config.
  _resolve() {
    const cfg = this._config;
    const entities = Object.assign({}, this._rawEntities);
    let prefix = cfg.device ? SLUG(cfg.device) : "";

    // device_id path: match each feature to a registry entity by name suffix.
    if (cfg.device_id && this._hass && this._hass.entities) {
      const mine = DEVICE_ENTITY_IDS(this._hass, cfg.device_id, prefix, "sensor");
      Object.keys(FEATURE_SUFFIX).forEach((k) => {
        if (!entities[k]) {
          const suf = FEATURE_SUFFIX[k];
          const found = mine.find((id) => id.slice(7) === suf || id.slice(7).endsWith("_" + suf));
          if (found) entities[k] = found;
        }
      });
      if (!prefix) {
        // Derive the node prefix from a matched entity (for faults/zones).
        const anyK = Object.keys(FEATURE_SUFFIX).find((k) => entities[k]);
        if (anyK) {
          const obj = entities[anyK].slice(entities[anyK].indexOf(".") + 1);
          const suf = FEATURE_SUFFIX[anyK];
          prefix = obj.length > suf.length + 1 ? obj.slice(0, obj.length - suf.length - 1) : "";
        }
        if (prefix || anyK) this._registryResolved = true;
      } else {
        this._registryResolved = true;
      }
    }

    // node-name string path (also fills any gaps left after device_id matching).
    if (prefix) {
      Object.keys(FEATURE_SUFFIX).forEach((k) => {
        if (!entities[k]) entities[k] = `sensor.${prefix}_${FEATURE_SUFFIX[k]}`;
      });
    }
    this._config.entities = entities;
    this._prefix = prefix;

    if (!this._rawFaults.length) {
      this._config.faults = Array.from({ length: 10 }, (_, i) =>
        prefix ? `sensor.${prefix}_fault_${i + 1}` : `sensor.fault_${i + 1}`
      );
    }

    // Auto-discover zones when the user didn't configure any (needs hass).
    if (!this._rawZones.length && !this._zonesResolved && this._hass) {
      const z = discoverZones(this._hass, cfg.device_id, prefix);
      if (z.length) {
        this._config.zones = z;
        this._zonesResolved = true;
      }
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._inPicker) {
      this._render();
      return;
    }
    // Resolve device_id/registry-backed ids + zones once hass is available.
    if (!this._registryResolved || (!this._zonesResolved && !this._rawZones.length)) {
      this._resolve();
    }
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      this._render();
    }
  }

  // True only when this element is rendered inside the "Add card" picker gallery.
  // The picker (hui-card-picker) hosts the card in its own shadow root, whereas
  // placed cards live in hui-card's light DOM. This lets us show a compact tile
  // in the picker without affecting the dashboard or edit mode.
  _detectPicker() {
    let node = this;
    for (let i = 0; i < 6 && node; i++) {
      const root = node.getRootNode ? node.getRootNode() : null;
      const host = root && root.host;
      if (host && host.localName === "hui-card-picker") return true;
      if (!host) break;
      node = host;
    }
    return false;
  }

  connectedCallback() {
    // Re-evaluate picker context on (re)connect, then render accordingly.
    this._inPicker = this._detectPicker();
    if (this._inPicker) this._render();
    if (this._bound) return;
    this._bound = true;
    // Delegated click handling for graphable tiles + chart controls.
    this.addEventListener("click", (ev) => {
      // Setpoint adjust: open the custom card-styled slider dialog.
      const sp = ev.target.closest("[data-setpoint]");
      if (sp) {
        ev.stopPropagation();
        this._openSetpoint(
          sp.getAttribute("data-setpoint"),
          sp.getAttribute("data-setpoint-label") || "",
          sp.getAttribute("data-setpoint-kind") || "heat"
        );
        return;
      }
      const range = ev.target.closest("[data-range]");
      if (range) {
        this._chart.range = range.getAttribute("data-range");
        this._render();
        return;
      }
      if (ev.target.closest("[data-chart-close]")) {
        this._chart.entity = null;
        this._render();
        return;
      }
      if (ev.target.closest("[data-chart-expand]")) {
        this._openModal(this._chart.entity, this._chart.label);
        return;
      }
      const g = ev.target.closest("[data-graph]");
      if (g) {
        const id = g.getAttribute("data-graph");
        if (this._chart.entity === id) {
          this._chart.entity = null; // toggle closed
        } else {
          this._chart.entity = id;
          this._chart.label = g.getAttribute("data-graph-label") || "";
        }
        this._render();
      }
    });
    // Delegated change handling for interactive select controls (fan/profile/system).
    this.addEventListener("change", (ev) => {
      const sel = ev.target.closest("select[data-select]");
      if (!sel) return;
      ev.stopPropagation();
      const id = sel.getAttribute("data-select");
      const option = sel.value;
      if (id && option && this._hass) {
        this._hass.callService("select", "select_option", {
          entity_id: id,
          option,
        });
      }
    });
  }

  // ---- history / chart -----------------------------------------------------

  async _fetchHistory(id, hours) {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const res = await this._hass.callWS({
      type: "history/history_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      entity_ids: [id],
      minimal_response: false,
      no_attributes: true,
      include_start_time_state: true,
    });
    const arr = (res && res[id]) || [];
    return arr
      .map((pt) => {
        const t =
          pt.lu != null
            ? pt.lu * 1000
            : pt.lc != null
            ? pt.lc * 1000
            : pt.last_updated
            ? Date.parse(pt.last_updated)
            : pt.last_changed
            ? Date.parse(pt.last_changed)
            : null;
        const v = parseFloat(pt.s != null ? pt.s : pt.state);
        return { t, v };
      })
      .filter((p) => p.t != null && !isNaN(p.v));
  }

  async _getHistory(id, hours) {
    const key = id + "|" + hours;
    const cached = this._histCache[key];
    if (cached && Date.now() - cached.ts < 20000) return cached.data;
    const data = await this._fetchHistory(id, hours);
    this._histCache[key] = { ts: Date.now(), data };
    return data;
  }

  // Apply the same display transforms the tiles use (C->F, stage decode).
  _transformSeries(id, data) {
    if (id === this._config.entities.stage) {
      return {
        pts: data.map((p) => ({ t: p.t, v: Math.floor(p.v) >> 1 })),
        unit: "stage",
        stepped: true,
      };
    }
    const st = this._stateObj(id);
    const nativeUnit =
      st && st.attributes ? st.attributes.unit_of_measurement || "" : "";
    if (this._config.temperature_unit === "F" && nativeUnit.includes("C")) {
      return { pts: data.map((p) => ({ t: p.t, v: TEMP_C_TO_F(p.v) })), unit: "°F" };
    }
    return { pts: data, unit: nativeUnit };
  }

  async _renderChart() {
    const host = this.querySelector("#chart-body");
    if (!host || !this._chart.entity) return;
    const id = this._chart.entity;
    const hours = RANGE_HOURS[this._chart.range] || 24;
    const token = ++this._chartToken;
    let data;
    try {
      data = await this._getHistory(id, hours);
    } catch (err) {
      if (token === this._chartToken)
        host.innerHTML = `<div class="chart-msg">History unavailable</div>`;
      return;
    }
    if (token !== this._chartToken) return; // superseded by a newer request
    const { pts, unit, stepped } = this._transformSeries(id, data);
    const xMax = Date.now();
    const xMin = xMax - hours * 3600 * 1000;
    host.innerHTML = this._svgChart(pts, unit, xMin, xMax, hours, stepped);
  }

  _fmt(v) {
    const a = Math.abs(v);
    const d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
    return Number(v.toFixed(d)).toString();
  }

  _buildChart(pts, unit, xMin, xMax, hours, big, stepped) {
    const W = big ? 900 : 600;
    const H = big ? 360 : 170;
    const padL = big ? 54 : 44;
    const padR = big ? 18 : 12;
    const padT = big ? 16 : 12;
    const padB = big ? 30 : 22;
    // Keep in-window points, but carry the last value from BEFORE the window in
    // as a starting point (a stable sensor's only recorded state may predate the
    // window), and extend the last known value to "now" so the line spans the
    // whole range instead of vanishing.
    const all = (pts || []).slice().sort((a, b) => a.t - b.t);
    let carry = null;
    const win = [];
    for (const p of all) {
      if (p.t < xMin) carry = p.v;
      else win.push(p);
    }
    if (carry !== null && (win.length === 0 || win[0].t > xMin))
      win.unshift({ t: xMin, v: carry });
    if (win.length && win[win.length - 1].t < xMax)
      win.push({ t: xMax, v: win[win.length - 1].v });
    pts = win;
    if (!pts.length)
      return { svg: `<div class="chart-msg">No history in this range</div>`, geom: null };
    const MAX = big ? 1200 : 600;
    if (pts.length > MAX) {
      const step = pts.length / MAX;
      const out = [];
      for (let i = 0; i < MAX; i++) out.push(pts[Math.floor(i * step)]);
      pts = out;
    }
    let dmin = Infinity,
      dmax = -Infinity;
    for (const p of pts) {
      if (p.v < dmin) dmin = p.v;
      if (p.v > dmax) dmax = p.v;
    }
    let vmin, vmax;
    if (stepped) {
      // discrete levels (e.g. compressor stage): pad by a fixed 0.4 so each
      // integer level sits on its own gridline.
      vmin = Math.floor(dmin) - 0.4;
      vmax = Math.ceil(dmax) + 0.4;
    } else {
      if (dmin === dmax) {
        dmin -= 1;
        dmax += 1;
      }
      const pad = (dmax - dmin) * 0.08;
      vmin = dmin - pad;
      vmax = dmax + pad;
    }
    const xspan = xMax - xMin || 1;
    const X = (t) => padL + ((t - xMin) / xspan) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - vmin) / (vmax - vmin)) * (H - padT - padB);
    const fmtV = stepped
      ? (v) => (Math.round(v) === 0 ? "Off" : "S" + Math.round(v))
      : (v) => this._fmt(v);
    let d = "";
    pts.forEach((p, i) => {
      const x = X(p.t).toFixed(1);
      const y = Y(p.v).toFixed(1);
      if (i === 0) {
        d += `M${x},${y} `;
      } else {
        // step-after: hold the previous value up to this x, then jump vertically
        d += `L${x},${Y(pts[i - 1].v).toFixed(1)} L${x},${y} `;
      }
    });
    const x0 = X(pts[0].t).toFixed(1);
    const x1 = X(pts[pts.length - 1].t).toFixed(1);
    const yb = Y(vmin).toFixed(1);
    const area = `${d}L ${x1},${yb} L ${x0},${yb} Z`;

    let tickVals = [];
    if (stepped) {
      for (let v = Math.floor(dmin); v <= Math.ceil(dmax); v++) tickVals.push(v);
    } else {
      const nY = big ? 5 : 3;
      for (let i = 0; i < nY; i++) tickVals.push(vmax - ((vmax - vmin) * i) / (nY - 1));
    }
    let grid = "";
    for (const tv of tickVals) {
      const y = Y(tv).toFixed(1);
      grid += `<line class="grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/><text class="lbl" x="${padL - 6}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${fmtV(tv)}</text>`;
    }
    const fmtT = (t) => {
      const dt = new Date(t);
      return hours > 24
        ? dt.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };
    let xl = "";
    if (big) {
      const nX = 6;
      for (let i = 0; i <= nX; i++) {
        const t = xMin + ((xMax - xMin) * i) / nX;
        const anchor = i === 0 ? "start" : i === nX ? "end" : "middle";
        xl += `<text class="lbl" x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}">${fmtT(t)}</text>`;
      }
    } else {
      xl =
        `<text class="lbl" x="${padL}" y="${H - 6}" text-anchor="start">${fmtT(xMin)}</text>` +
        `<text class="lbl" x="${W - padR}" y="${H - 6}" text-anchor="end">${fmtT(xMax)}</text>`;
    }
    const last = pts[pts.length - 1];
    const dot = `<circle class="dot" cx="${x1}" cy="${Y(last.v).toFixed(1)}" r="3"/>`;
    const curTxt = stepped ? fmtV(last.v) : `${this._fmt(last.v)}${unit ? " " + unit : ""}`;
    const cur = `<text class="cur" x="${W - padR}" y="${padT + 10}" text-anchor="end">${curTxt}</text>`;
    const xhair = big
      ? `<g class="xhair" style="display:none"><line class="xh-line" x1="0" y1="${padT}" x2="0" y2="${H - padB}"/><circle class="xh-dot" cx="0" cy="0" r="4"/></g>`
      : "";
    const svg = `<svg viewBox="0 0 ${W} ${H}" class="spark${big ? " big" : ""}">${grid}<path class="area" d="${area}"/><path class="line" d="${d}"/>${dot}${xl}${cur}${xhair}</svg>`;
    const geom = { W, H, padL, padR, padT, padB, xMin, xMax, vmin, vmax, pts, unit, hours, X, Y, stepped };
    return { svg, geom };
  }

  _svgChart(pts, unit, xMin, xMax, hours, stepped) {
    return this._buildChart(pts, unit, xMin, xMax, hours, false, stepped).svg;
  }

  _chartPanel() {
    if (!this._chart.entity) return "";
    const btns = Object.keys(RANGE_HOURS)
      .map(
        (r) =>
          `<button class="range-btn${r === this._chart.range ? " on" : ""}" data-range="${r}">${r}</button>`
      )
      .join("");
    return `<div class="chart-wrap">
      <div class="chart-head">
        <span class="chart-title">${this._chart.label || ""} · history</span>
        <span class="chart-ranges">${btns}</span>
        <ha-icon class="chart-expand" icon="mdi:arrow-expand-all" data-chart-expand title="Open large interactive view"></ha-icon>
        <ha-icon class="chart-close" icon="mdi:close" data-chart-close title="Close chart"></ha-icon>
      </div>
      <div class="chart-body" id="chart-body"><div class="chart-msg">Loading…</div></div>
    </div>`;
  }

  // ---- large interactive modal --------------------------------------------

  _openModal(entity, label) {
    if (!entity) return;
    this._modal = { entity, label, range: this._chart.range || "24h" };
    if (!this._modalEl) {
      const el = document.createElement("div");
      el.className = "infsp-modal-root";
      el.innerHTML = `${this._modalStyles()}
        <div class="modal-backdrop" data-modal-close></div>
        <div class="modal-box" role="dialog" aria-modal="true">
          <div class="modal-head">
            <span class="modal-title"></span>
            <span class="modal-ranges"></span>
            <ha-icon icon="mdi:close" data-modal-close title="Close"></ha-icon>
          </div>
          <div class="modal-chart"><div class="xh-tip" style="display:none"></div><div class="chart-msg">Loading…</div></div>
          <div class="modal-hint">Move the cursor over the chart to read values.</div>
        </div>`;
      document.body.appendChild(el);
      this._modalEl = el;
      el.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-modal-close]")) {
          this._closeModal();
          return;
        }
        const r = ev.target.closest("[data-mrange]");
        if (r) {
          this._modal.range = r.getAttribute("data-mrange");
          this._renderModal();
        }
      });
      const chartC = el.querySelector(".modal-chart");
      chartC.addEventListener("pointermove", (ev) => this._onModalMove(ev));
      chartC.addEventListener("pointerleave", () => this._hideXhair());
      this._onKey = (ev) => {
        if (ev.key === "Escape") this._closeModal();
      };
    }
    document.addEventListener("keydown", this._onKey);
    this._modalEl.style.display = "block";
    this._renderModal();
  }

  _closeModal() {
    if (this._modalEl) this._modalEl.style.display = "none";
    if (this._onKey) document.removeEventListener("keydown", this._onKey);
    this._modal = null;
    this._modalGeom = null;
    this._modalToken = (this._modalToken || 0) + 1; // cancel pending fetch
  }

  async _renderModal() {
    if (!this._modal || !this._modalEl) return;
    const id = this._modal.entity;
    const hours = RANGE_HOURS[this._modal.range] || 24;
    this._modalEl.querySelector(".modal-title").textContent =
      (this._modal.label || "") + " · history";
    this._modalEl.querySelector(".modal-ranges").innerHTML = Object.keys(RANGE_HOURS)
      .map(
        (r) =>
          `<button class="range-btn${r === this._modal.range ? " on" : ""}" data-mrange="${r}">${r}</button>`
      )
      .join("");
    const host = this._modalEl.querySelector(".modal-chart");
    const token = (this._modalToken = (this._modalToken || 0) + 1);
    let data;
    try {
      data = await this._getHistory(id, hours);
    } catch (err) {
      if (token === this._modalToken)
        host.innerHTML = `<div class="xh-tip" style="display:none"></div><div class="chart-msg">History unavailable</div>`;
      return;
    }
    if (token !== this._modalToken || !this._modal) return;
    const { pts, unit, stepped } = this._transformSeries(id, data);
    const xMax = Date.now();
    const xMin = xMax - hours * 3600 * 1000;
    const built = this._buildChart(pts, unit, xMin, xMax, hours, true, stepped);
    host.innerHTML = `<div class="xh-tip" style="display:none"></div>` + built.svg;
    this._modalGeom = built.geom;
  }

  _hideXhair() {
    if (!this._modalEl) return;
    const g = this._modalEl.querySelector(".xhair");
    if (g) g.style.display = "none";
    const tip = this._modalEl.querySelector(".xh-tip");
    if (tip) tip.style.display = "none";
  }

  _onModalMove(ev) {
    const g = this._modalGeom;
    if (!g || !this._modalEl) return;
    const svg = this._modalEl.querySelector(".modal-chart svg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vbX = ((ev.clientX - rect.left) / rect.width) * g.W;
    const tt = g.xMin + ((vbX - g.padL) / (g.W - g.padL - g.padR)) * (g.xMax - g.xMin);
    let best = g.pts[0],
      bd = Infinity;
    for (const p of g.pts) {
      const d = Math.abs(p.t - tt);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    const sx = g.X(best.t),
      sy = g.Y(best.v);
    const grp = svg.querySelector(".xhair");
    if (grp) {
      grp.style.display = "";
      const line = svg.querySelector(".xh-line");
      line.setAttribute("x1", sx.toFixed(1));
      line.setAttribute("x2", sx.toFixed(1));
      const dot = svg.querySelector(".xh-dot");
      dot.setAttribute("cx", sx.toFixed(1));
      dot.setAttribute("cy", sy.toFixed(1));
    }
    const tip = this._modalEl.querySelector(".xh-tip");
    const dt = new Date(best.t);
    const valTxt = g.stepped
      ? Math.round(best.v) === 0
        ? "Off"
        : "Stage " + Math.round(best.v)
      : `${this._fmt(best.v)}${g.unit ? " " + g.unit : ""}`;
    tip.innerHTML = `<b>${valTxt}</b><span>${dt.toLocaleString(
      [],
      { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    )}</span>`;
    tip.style.display = "";
    const host = this._modalEl.querySelector(".modal-chart");
    const hrect = host.getBoundingClientRect();
    const pxX = rect.left - hrect.left + (sx / g.W) * rect.width;
    const pxY = rect.top - hrect.top + (sy / g.H) * rect.height;
    const tw = tip.offsetWidth || 130;
    let left = pxX + 14;
    if (left + tw > hrect.width) left = pxX - tw - 14;
    tip.style.left = Math.max(2, left) + "px";
    tip.style.top = Math.max(2, pxY - 12) + "px";
  }

  disconnectedCallback() {
    this._closeModal();
    if (this._modalEl && this._modalEl.parentNode) {
      this._modalEl.parentNode.removeChild(this._modalEl);
      this._modalEl = null;
    }
  }

  // ---- helpers -------------------------------------------------------------

  _stateObj(id) {
    return id && this._hass && this._hass.states ? this._hass.states[id] : null;
  }
  _state(id) {
    const s = this._stateObj(id);
    return s ? s.state : null;
  }
  _num(id) {
    const v = parseFloat(this._state(id));
    return isNaN(v) ? null : v;
  }
  _unit(id) {
    const s = this._stateObj(id);
    return s && s.attributes ? s.attributes.unit_of_measurement || "" : "";
  }

  _signature() {
    const e = this._config.entities || {};
    const ids = [
      e.outdoor_temp,
      e.coil_temp,
      e.stage,
      e.line_voltage,
      e.airflow,
      e.blower_rpm,
      e.blower_watts,
      e.static_pressure,
      e.odu_model,
      e.furnace_model,
      e.zoning_model,
    ].concat(this._config.faults || []);
    const parts = ids.map((id) => this._state(id));
    // Zones: track temp/humidity state + damper position (a cover attribute,
    // so plain state wouldn't reflect position changes).
    (this._config.zones || []).forEach((z) => {
      const rz = ZONE_ENTITY_IDS(this._hass, z, this._prefix);
      parts.push(
        this._state(rz.temp),
        this._state(rz.humidity),
        String(this._damperPct(rz.damper)),
        this._state(rz.heat_target),
        this._state(rz.cool_target)
      );
    });
    return parts.join("|");
  }

  // Model chip for a section header — a link that searches the model number.
  _modelChip(id) {
    const m = id ? this._state(id) : null;
    if (!m || m === "unknown" || m === "unavailable") return "";
    const url = "https://www.google.com/search?q=" + encodeURIComponent(m);
    return `<a class="sec-model" href="${url}" target="_blank" rel="noopener noreferrer" title="Search this model number">${m}<ha-icon class="ext" icon="mdi:open-in-new"></ha-icon></a>`;
  }

  // True when temperatures should be displayed in °F. Follows the card's
  // `temperature_unit` config; when that's unset/auto, follows the Home
  // Assistant system unit (so it tracks the user's locale/component setup).
  _wantF() {
    const cfg = this._config.temperature_unit;
    if (cfg === "F") return true;
    if (cfg === "C") return false;
    const sys =
      this._hass && this._hass.config && this._hass.config.unit_system
        ? this._hass.config.unit_system.temperature
        : "";
    return String(sys).includes("F");
  }

  // Temperature as a display string (converts to the display unit).
  _tempStr(id) {
    const c = this._num(id);
    if (c === null) return "—";
    const u = this._unit(id);
    const wantF = this._wantF();
    if (wantF && u.includes("C")) return TEMP_C_TO_F(c).toFixed(1) + "°";
    if (!wantF && u.includes("F")) return ((c - 32) * (5 / 9)).toFixed(1) + "°";
    return c.toFixed(1) + "°";
  }

  // ---- setpoint adjust dialog (custom, card-styled) -----------------------
  // A modal with a vertical slider bound to a number entity. Shows the live
  // reading in the display unit, Apply (commit) and Cancel (revert to the value
  // present when opened). The DOM is built once; drag/nudge patch it in place
  // (no full re-render) so dragging is smooth.
  _openSetpoint(entityId, label, kind) {
    const s = this._stateObj(entityId);
    if (!s) return;
    const u = s.attributes.unit_of_measurement || "";
    const wantF = this._wantF();
    const cToF = wantF && u.includes("C");
    const fToC = !wantF && u.includes("F");
    const toDisp = (v) => (cToF ? TEMP_C_TO_F(v) : fToC ? (v - 32) * (5 / 9) : v);
    const toNative = (d) => (cToF ? (d - 32) * (5 / 9) : fToC ? TEMP_C_TO_F(d) : d);
    const cur = Number(s.state);
    const nMin = typeof s.attributes.min === "number" ? s.attributes.min : toNative(wantF ? 40 : 4);
    const nMax = typeof s.attributes.max === "number" ? s.attributes.max : toNative(wantF ? 99 : 37);
    const dmin = Math.round(toDisp(nMin));
    const dmax = Math.round(toDisp(nMax));
    const orig = Math.round(toDisp(cur));
    this._sp = {
      entity: entityId,
      label,
      kind: kind || "heat",
      unit: wantF ? "°F" : cToF || fToC ? (wantF ? "°F" : "°C") : u || (wantF ? "°F" : "°C"),
      min: dmin,
      max: dmax,
      orig,
      val: Math.max(dmin, Math.min(dmax, orig)),
      toNative,
    };

    if (!this._spEl) {
      const el = document.createElement("div");
      el.className = "infsp-modal-root infsp-sp-root";
      document.body.appendChild(el);
      this._spEl = el;
      this._spKey = (ev) => {
        if (ev.key === "Escape") this._closeSetpoint();
        else if (ev.key === "Enter") this._applySetpoint();
      };
    }
    // Build the dialog DOM once per open.
    const sp = this._sp;
    this._spEl.innerHTML = `${this._modalStyles()}${this._setpointStyles()}
      <div class="modal-backdrop" data-sp-cancel></div>
      <div class="modal-box sp-box ${sp.kind}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <span class="modal-title">${sp.label}</span>
          <ha-icon icon="mdi:close" data-sp-cancel title="Cancel"></ha-icon>
        </div>
        <div class="sp-body">
          <div class="sp-reading"><span class="sp-num">${sp.val}</span><span class="sp-unit">${sp.unit}</span></div>
          <div class="sp-adjust">
            <button class="sp-nudge" data-sp-step="1" title="Warmer">+</button>
            <div class="sp-slider" data-sp-track>
              <div class="sp-max">${sp.max}°</div>
              <div class="sp-track">
                <div class="sp-fill"></div>
                <div class="sp-thumb"></div>
              </div>
              <div class="sp-min">${sp.min}°</div>
            </div>
            <button class="sp-nudge" data-sp-step="-1" title="Cooler">−</button>
          </div>
        </div>
        <div class="sp-actions">
          <button class="sp-act cancel" data-sp-cancel>Cancel</button>
          <button class="sp-act apply" data-sp-apply>Apply</button>
        </div>
      </div>`;

    // Cache the elements we patch during interaction.
    this._spNum = this._spEl.querySelector(".sp-num");
    this._spFill = this._spEl.querySelector(".sp-fill");
    this._spThumb = this._spEl.querySelector(".sp-thumb");
    this._spApply = this._spEl.querySelector(".sp-act.apply");
    const track = this._spEl.querySelector(".sp-track");

    // One click listener for buttons/backdrop.
    this._spEl.onclick = (ev) => {
      if (ev.target.closest("[data-sp-cancel]")) return this._closeSetpoint();
      if (ev.target.closest("[data-sp-apply]")) return this._applySetpoint();
      const step = ev.target.closest("[data-sp-step]");
      if (step) {
        this._setSpVal(this._sp.val + Number(step.getAttribute("data-sp-step")));
      }
    };

    // Drag on the track — patches in place (no re-render), so it slides.
    const valFromY = (clientY) => {
      const r = track.getBoundingClientRect();
      let f = 1 - (clientY - r.top) / r.height; // top = max
      f = Math.max(0, Math.min(1, f));
      return Math.round(this._sp.min + f * (this._sp.max - this._sp.min));
    };
    track.onpointerdown = (ev) => {
      ev.preventDefault();
      track.setPointerCapture && track.setPointerCapture(ev.pointerId);
      this._setSpVal(valFromY(ev.clientY));
      const move = (e) => this._setSpVal(valFromY(e.clientY));
      const up = () => {
        track.removeEventListener("pointermove", move);
        track.removeEventListener("pointerup", up);
      };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
    };

    document.addEventListener("keydown", this._spKey);
    this._spEl.style.display = "block";
    this._paintSp();
  }

  // Set the working value (clamped) and repaint the changed bits in place.
  _setSpVal(v) {
    const sp = this._sp;
    if (!sp) return;
    const nv = Math.max(sp.min, Math.min(sp.max, Math.round(v)));
    if (nv === sp.val) return;
    sp.val = nv;
    this._paintSp();
  }

  // Patch reading, fill, thumb, and Apply state — no innerHTML rebuild.
  _paintSp() {
    const sp = this._sp;
    if (!sp || !this._spNum) return;
    const pct = ((sp.val - sp.min) / (sp.max - sp.min || 1)) * 100;
    this._spNum.textContent = sp.val;
    this._spFill.style.height = pct + "%";
    this._spThumb.style.bottom = pct + "%";
    const changed = sp.val !== sp.orig;
    this._spApply.classList.toggle("on", changed);
    this._spApply.toggleAttribute("disabled", !changed);
  }

  _applySetpoint() {
    const sp = this._sp;
    if (!sp) return;
    if (sp.val !== sp.orig) {
      this._hass.callService("number", "set_value", {
        entity_id: sp.entity,
        value: sp.toNative(sp.val),
      });
    }
    this._closeSetpoint();
  }

  _closeSetpoint() {
    // Cancel/close discards this._sp without calling the service (revert).
    if (this._spEl) this._spEl.style.display = "none";
    if (this._spKey) document.removeEventListener("keydown", this._spKey);
    this._sp = null;
  }

  // ---- large interactive chart modal --------------------------------------

  // Editable setpoint cell: the whole cell opens the inline history graph (like
  // other metrics, with a light chart-icon hint on the right); the accent pencil
  // button next to the reading opens the custom slider dialog. Renders "—" when
  // the entity is absent.
  _setpointCell(icon, id, label) {
    if (!id || !this._stateObj(id))
      return `<span class="zone-metric zv" title="${label}">
        <ha-icon icon="${icon}"></ha-icon>
        <span class="zm-body"><span class="zm-val">—</span><span class="zm-label">${label}</span></span>
      </span>`;
    const gl = label.replace(/"/g, "&quot;");
    const kind = icon.includes("snowflake") ? "cool" : "heat";
    return `<span class="zone-metric setpoint zv clickable" data-graph="${id}" data-graph-label="${gl}" title="${label}">
        <ha-icon icon="${icon}"></ha-icon>
        <span class="zm-body">
          <span class="zm-text">
            <span class="zm-val">${this._tempStr(id)}</span>
            <span class="zm-label">${label}</span>
          </span>
          <button class="sp-edit ${kind}" data-setpoint="${id}" data-setpoint-label="${gl}" data-setpoint-kind="${kind}" title="Adjust ${label}">
            <ha-icon icon="mdi:pencil"></ha-icon>
          </button>
        </span>
        <ha-icon class="g-ic" icon="mdi:chart-line"></ha-icon>
      </span>`;
  }

  // Options list for a select entity (from its `options` attribute). [] if absent.
  _selectOptions(id) {
    const s = this._stateObj(id);
    const o = s && s.attributes && s.attributes.options;
    return Array.isArray(o) ? o : [];
  }

  // Inner <select> control for a select entity. Reflects the current state and
  // writes via select.select_option on change (wired by the delegated handler).
  // `ctx` selects the option-label vocabulary (system_mode / fan_mode / profile).
  _selectControl(id, ctx, accent) {
    const cur = this._state(id);
    const opts = this._selectOptions(id);
    const options = opts
      .map((o) => `<option value="${o}"${o === cur ? " selected" : ""}>${OPT_LABEL(o, ctx)}</option>`)
      .join("");
    return `<select class="inf-select${accent ? " " + accent : ""}" data-select="${id}">${options}</select>`;
  }

  // Editable per-zone select cell (fan mode / profile). Renders "—" when absent.
  _selectCell(icon, id, label, ctx, accent) {
    if (!id || !this._stateObj(id) || !this._selectOptions(id).length)
      return `<span class="zone-metric zselect" title="${label}">
        <ha-icon icon="${icon}"></ha-icon>
        <span class="zm-body"><span class="zm-val">—</span><span class="zm-label">${label}</span></span>
      </span>`;
    return `<span class="zone-metric zselect" title="${label}">
        <ha-icon icon="${icon}"></ha-icon>
        <span class="zm-body">
          ${this._selectControl(id, ctx, accent)}
          <span class="zm-label">${label}</span>
        </span>
      </span>`;
  }

  // Air-handler select tile (system mode). Matches the .tile layout.
  _selectTile(id, label, icon, ctx) {
    if (!id || !this._stateObj(id) || !this._selectOptions(id).length)
      return this._tile(icon, label, "—", "", null, null);
    return `
      <div class="tile tile-select">
        <ha-icon icon="${icon}"></ha-icon>
        <div class="tile-body">
          ${this._selectControl(id, ctx)}
          <div class="tile-label">${label}</div>
        </div>
      </div>`;
  }

  // Resolve a main-node select entity id (e.g. system_mode) by suffix: explicit
  // override, then device_id registry, then the node-name prefix.
  _selectFeatureId(suffix) {
    const cfg = this._config;
    const override = (this._config.entities || {})[suffix];
    if (override) return override;
    if (cfg.device_id && this._hass && this._hass.entities) {
      const ids = DEVICE_ENTITY_IDS(this._hass, cfg.device_id, this._prefix, "select");
      const f = ids.find((id) => id.slice(7) === suffix || id.slice(7).endsWith("_" + suffix));
      if (f) return f;
    }
    return this._prefix ? `select.${this._prefix}_${suffix}` : "";
  }

  // Damper percent from either a cover entity (current_position attribute) or a
  // plain numeric sensor. Returns null if unavailable.
  _damperPct(id) {
    const s = this._stateObj(id);
    if (!s) return null;
    if (s.attributes && s.attributes.current_position != null) {
      const p = parseFloat(s.attributes.current_position);
      return isNaN(p) ? null : p;
    }
    const v = parseFloat(s.state);
    return isNaN(v) ? null : v;
  }

  // Is this damper entity history-graphable? A numeric sensor is; a cover
  // (position lives in an attribute) is not.
  _damperGraphable(id) {
    return !!id && !String(id).startsWith("cover.");
  }

  _zoneRow(z) {
    z = ZONE_ENTITY_IDS(this._hass, z, this._prefix);
    const hum = this._num(z.humidity);
    const damp = this._damperPct(z.damper);
    const zv = (icon, val, id, label) =>
      `<span class="zone-metric zv${id ? " clickable" : ""}"${
        id
          ? ` data-graph="${id}" data-graph-label="${((z.name || "Zone") + " " + label).replace(/"/g, "&quot;")}"`
          : ""
      } title="${label}">
        <ha-icon icon="${icon}"></ha-icon>
        <span class="zm-body"><span class="zm-val">${val}</span><span class="zm-label">${label}</span></span>
        ${id ? `<ha-icon class="g-ic" icon="mdi:chart-line"></ha-icon>` : ""}
      </span>`;
    // Damper: a full-width meter with the % centered over it. Graphable when sensor.
    const dGraph = this._damperGraphable(z.damper) ? z.damper : null;
    const pct = damp === null ? null : Math.max(0, Math.min(100, damp));
    const meter =
      damp === null
        ? `<span class="dmeter empty">—</span>`
        : `<span class="dmeter"><span class="dfill" style="width:${pct}%"></span><span class="dtext">${Math.round(damp)}%</span></span>`;
    const dampCell = `<span class="zone-metric damper zv${dGraph ? " clickable" : ""}"${
      dGraph ? ` data-graph="${dGraph}" data-graph-label="${((z.name || "Zone") + " Damper").replace(/"/g, "&quot;")}"` : ""
    } title="Damper${damp === null ? "" : " " + Math.round(damp) + "%"}">
        <ha-icon icon="mdi:valve"></ha-icon>
        <span class="zm-body">${meter}<span class="zm-label">Damper Open</span></span>
        ${dGraph ? `<ha-icon class="g-ic" icon="mdi:chart-line"></ha-icon>` : ""}
      </span>`;
    // Cells keyed by metric so the user-configured order (sections.zoning) applies.
    const cells = {
      temp: zv("mdi:thermometer", this._tempStr(z.temp), z.temp, "Temp"),
      humidity: zv("mdi:water-percent", hum === null ? "—" : hum.toFixed(0) + "%", z.humidity, "Humidity"),
      damper: dampCell,
    };
    // Setpoint targets (number entities): editable inline via −/+ steppers,
    // graphable by clicking the value. Only rendered when the entity exists.
    const has = (id) => id && this._hass && this._hass.states[id];
    if (has(z.heat_target))
      cells.heat_target = this._setpointCell("mdi:fire", z.heat_target, "Heat To");
    if (has(z.cool_target))
      cells.cool_target = this._setpointCell("mdi:snowflake", z.cool_target, "Cool To");
    // Interactive per-zone selects (fan mode, comfort profile / hold).
    cells.fan_mode = this._selectCell("mdi:fan", z.fan_mode, "Fan", "fan_mode");
    cells.profile = this._selectCell("mdi:calendar-clock", z.profile, "Profile", "profile");
    const metrics = this._sectionFeatures("zoning").map((k) => cells[k] || "").join("");
    return `<div class="zone">
      <div class="zone-head">${z.name || "Zone"}</div>
      <div class="zone-metrics">
        ${metrics}
      </div>
    </div>`;
  }

  _parseFault(raw) {
    if (!raw) return null;
    const s = raw.trim();
    if (s === "—" || s === "" || s === "unknown" || s === "unavailable")
      return null;
    const m = s.match(
      /^(FAULT|notice)\s+(.+?)\s+(\S+)\s+(\d{4}-\d{2}-\d{2}|\d+d-ago)\s+(\d{2}:\d{2})\s+x(\d+)$/
    );
    if (!m) {
      return {
        severity: s.startsWith("FAULT") ? "FAULT" : "notice",
        desc: s,
        code: "",
        src: "",
        date: "",
        time: "",
        count: "",
        raw: true,
      };
    }
    let desc = m[2];
    let code = "";
    const cm = desc.match(/\((\d+)\)\s*$/);
    if (cm) {
      code = cm[1];
      desc = desc.replace(/\s*\(\d+\)\s*$/, "");
    } else {
      const cm2 = desc.match(/^code\s+(\d+)$/i);
      if (cm2) code = cm2[1];
    }
    // Prefer our (extensible) code table for the description.
    if (code && this._codes[code]) desc = this._codes[code];
    else if (!desc || /^code\s+\d+$/i.test(desc)) desc = code ? `Code ${code}` : desc;
    return {
      severity: m[1],
      desc,
      code,
      src: m[3],
      date: m[4],
      time: m[5],
      count: m[6],
      raw: false,
    };
  }

  _tempTile(id, label, icon) {
    const c = this._num(id);
    const g = id ? { id, label } : null;
    if (c === null) return this._tile(icon, label, "—", "", null, g);
    const nativeUnit = this._unit(id);
    if (this._config.temperature_unit === "F" && nativeUnit.includes("C")) {
      return this._tile(icon, label, TEMP_C_TO_F(c).toFixed(1), "°F", null, g);
    }
    return this._tile(icon, label, c.toFixed(1), nativeUnit || "°", null, g);
  }

  _tile(icon, label, value, unit, accent, graph) {
    const g = graph && graph.id;
    const open = g && this._chart && this._chart.entity === graph.id;
    const gLabel = (graph && (graph.label || label) ? graph.label || label : "").replace(/"/g, "&quot;");
    const attrs = g ? ` data-graph="${graph.id}" data-graph-label="${gLabel}"` : "";
    const cls = `tile${accent ? " accent-" + accent : ""}${g ? " clickable" : ""}${open ? " open" : ""}`;
    const gic = g ? `<ha-icon class="g-ic" icon="mdi:chart-line"></ha-icon>` : "";
    return `
      <div class="${cls}"${attrs}>
        <ha-icon icon="${icon}"></ha-icon>
        <div class="tile-body">
          <div class="tile-value">${value}<span class="unit">${unit || ""}</span></div>
          <div class="tile-label">${label}</div>
        </div>${gic}
      </div>`;
  }

  _numTile(id, label, icon, unit, digits, accent) {
    const v = this._num(id);
    return this._tile(
      icon,
      label,
      v === null ? "—" : v.toFixed(digits || 0),
      unit,
      accent,
      id ? { id, label } : null
    );
  }

  _stageLabel() {
    const raw = this._num(this._config.entities.stage);
    if (raw === null) return { text: "—", running: false };
    const idx = Math.floor(raw) >> 1; // firmware raw byte -> stage index
    const labels = ["Off", "Stage 1", "Stage 2", "Stage 3", "Stage 4", "Stage 5"];
    return { text: labels[idx] || `Stage ${idx}`, running: idx > 0 };
  }

  _staticPressure() {
    const cfm = this._num(this._config.entities.airflow);
    if (cfm === null || cfm <= 0) return "0.00";
    // Preferred: physical watts model  SP = k * BlowerWatts / CFM
    // (air power = efficiency * motor power). Most accurate — the furnace's own
    // static-pressure calc is torque/current based, and watts captures the load.
    const wId = this._config.entities.blower_watts;
    if (wId) {
      const w = this._num(wId);
      if (w !== null && w > 0)
        return ((this._config.static_watts_k * w) / cfm).toFixed(2);
      if (w !== null) return "0.00"; // blower off
    }
    const rpmId = this._config.entities.blower_rpm;
    if (rpmId) {
      // Next: two-input RPM + airflow power law.
      const rpm = this._num(rpmId);
      if (rpm !== null && rpm > 0) {
        const sp =
          this._config.static_k *
          Math.pow(rpm, this._config.static_rpm_exp) *
          Math.pow(cfm, this._config.static_cfm_exp);
        return sp.toFixed(2);
      }
      return "0.00"; // blower off/unknown -> ~no static
    }
    // Fallback: CFM-only if no blower_rpm entity is configured.
    return (this._config.static_k_cfm * Math.pow(cfm, this._config.static_cfm_only_exp)).toFixed(2);
  }

  _faultUrl(f) {
    const tmpl = this._config.fault_link || "";
    if (!tmpl) return "";
    return tmpl
      .replace(/\{code\}/g, encodeURIComponent(f.code || f.desc || ""))
      .replace(/\{desc\}/g, encodeURIComponent(f.desc || ""));
  }

  _section(label, right, tilesHtml, extra) {
    return `
      <div class="section">
        <div class="section-label">${label}${right || ""}</div>
        <div class="metrics">${tilesHtml}</div>
        ${extra || ""}
      </div>`;
  }

  // Ordered, validated feature keys for a section. Falls back to defaults when
  // the user hasn't configured `sections.<name>`.
  _sectionFeatures(section) {
    const valid = SECTION_KEYS(section);
    const cfg = (this._config.sections || {})[section];
    if (Array.isArray(cfg)) return cfg.filter((k) => valid.includes(k));
    return DEFAULT_SECTIONS[section].slice();
  }

  // Entity ids backing a section's current features (for chart-owner lookup).
  _sectionEntityIds(section) {
    const e = this._config.entities || {};
    return this._sectionFeatures(section).map((k) => e[k]).filter(Boolean);
  }

  // Render one odu/idu tile from the feature registry.
  _renderFeature(key) {
    const e = this._config.entities || {};
    const f = FEATURES[key];
    if (!f) return "";
    switch (f.kind) {
      case "temp":
        return this._tempTile(e[key], f.label, f.icon);
      case "num":
        return this._numTile(e[key], f.label, f.icon, f.unit, f.digits, f.accent);
      case "stage": {
        const stage = this._stageLabel();
        return this._tile(f.icon, f.label, stage.text, "", stage.running ? "green" : "gray", e[key] ? { id: e[key], label: f.label } : null);
      }
      case "static":
        // Prefer a real static_pressure entity (firmware-computed, graphable);
        // otherwise fall back to the card's on-the-fly estimate.
        return e[key]
          ? this._numTile(e[key], f.label, f.icon, f.unit, f.digits, f.accent)
          : this._tile(f.icon, f.label, this._staticPressure(), f.unit, f.accent);
      case "select":
        return this._selectTile(this._selectFeatureId(key), f.label, f.icon, key);
      default:
        return "";
    }
  }

  // ---- render --------------------------------------------------------------

  // Compact card-picker preview (only in the "Add card" gallery). Shows the card
  // title plus each section's name and a small row of its sensor icons — enough
  // to recognize the card without rendering every tile with empty placeholders.
  _previewHtml() {
    const iconRow = (keys, reg) =>
      keys
        .map((k) => reg[k] && `<ha-icon class="pv-mic" icon="${reg[k].icon}" title="${reg[k].label}"></ha-icon>`)
        .filter(Boolean)
        .join("");
    const section = (icon, name, iconsHtml) => `
      <div class="pv-sec">
        <div class="pv-sec-head"><ha-icon class="pv-sec-ic" icon="${icon}"></ha-icon><span>${name}</span></div>
        <div class="pv-mics">${iconsHtml}</div>
      </div>`;
    const odu = section("mdi:heat-pump-outline", "Outdoor Unit", iconRow(DEFAULT_SECTIONS.odu, FEATURES));
    const idu = section("mdi:fan", "Air Handler", iconRow(DEFAULT_SECTIONS.idu, FEATURES));
    const zoning = section("mdi:view-dashboard-outline", "Zoning", iconRow(DEFAULT_SECTIONS.zoning, ZONE_METRICS));
    const faults = section("mdi:alert-outline", "Fault History", `<ha-icon class="pv-mic" icon="mdi:history" title="Recent faults &amp; notices"></ha-icon>`);
    return `${this._styles()}
      <style>
        .infsp-preview { padding:12px 14px; }
        .infsp-preview .pv-top { display:flex; gap:10px; align-items:center; margin-bottom:10px; }
        .infsp-preview .pv-ic { --mdc-icon-size:28px; color: var(--primary-color); flex:none; }
        .infsp-preview .pv-title { font-weight:600; font-size:.95rem; }
        .infsp-preview .pv-sub { color: var(--secondary-text-color); font-size:.75rem; margin-top:1px; }
        .infsp-preview .pv-secs { display:flex; flex-direction:column; gap:8px; }
        .infsp-preview .pv-sec-head { display:flex; align-items:center; gap:6px; font-size:.82rem; font-weight:600; }
        .infsp-preview .pv-sec-ic { --mdc-icon-size:18px; color: var(--primary-color); }
        .infsp-preview .pv-mics { display:flex; flex-wrap:wrap; gap:8px; margin:3px 0 0 24px; color: var(--secondary-text-color); }
        .infsp-preview .pv-mic { --mdc-icon-size:18px; }
      </style>
      <ha-card>
        <div class="infsp-preview">
          <div class="pv-top">
            <ha-icon class="pv-ic" icon="mdi:hvac"></ha-icon>
            <div>
              <div class="pv-title">${(this._config && this._config.title) || "Carrier Infinity"}</div>
              <div class="pv-sub">Live ODU, air handler, zoning &amp; fault history</div>
            </div>
          </div>
          <div class="pv-secs">
            ${odu}
            ${idu}
            ${zoning}
            ${faults}
          </div>
        </div>
      </ha-card>`;
  }

  _render() {
    if (this._inPicker) {
      this.innerHTML = this._previewHtml();
      return;
    }
    if (!this._hass) return;
    const e = this._config.entities || {};

    // Outdoor Unit panel
    const outdoor = this._sectionFeatures("odu").map((k) => this._renderFeature(k)).join("");

    // Air Handler panel (static pressure prefers the firmware sensor; see
    // _renderFeature). Feature order/visibility follows the `sections.idu` list.
    const indoor = this._sectionFeatures("idu").map((k) => this._renderFeature(k)).join("");

    // Faults. Distinguish "not received yet" (all entities unknown/unavailable)
    // from "received and empty" (firmware publishes "—" for empty slots).
    const rawStates = (this._config.faults || []).map((id) => this._state(id));
    const received = rawStates.some(
      (s) => s !== null && s !== "unknown" && s !== "unavailable"
    );
    const faults = rawStates.map((s) => this._parseFault(s)).filter((f) => f);

    let faultRows;
    if (!received) {
      faultRows = `<div class="retrieving"><ha-icon class="spin" icon="mdi:progress-clock"></ha-icon> Retrieving fault history…</div>`;
    } else if (faults.length === 0) {
      faultRows = `<div class="no-faults"><ha-icon icon="mdi:check-circle"></ha-icon> No faults recorded</div>`;
    } else {
      faultRows = faults
        .map((f) => {
          const sevClass = f.severity === "FAULT" ? "sev-fault" : "sev-notice";
          const sevIcon = f.severity === "FAULT" ? "mdi:alert-circle" : "mdi:information";
          const sevTitle = f.severity === "FAULT" ? "Fault" : "Notice (informational)";
          const srcTitle = `Report source: ${SRC_NAMES[f.src] || f.src}`;
          const url = this._faultUrl(f);
          const descInner = `${f.desc}`;
          const descHtml = url
            ? `<a class="f-link" href="${url}" target="_blank" rel="noopener noreferrer" title="Look up this fault code">${descInner}<ha-icon class="ext" icon="mdi:open-in-new"></ha-icon></a>`
            : descInner;
          const codeChip = f.code
            ? `<span class="chip code" title="Fault code (click the description to look it up)">#${f.code}</span>`
            : "";
          if (f.raw) {
            return `<div class="fault ${sevClass}">
              <ha-icon class="sev" icon="${sevIcon}" title="${sevTitle}"></ha-icon>
              <div class="f-main"><div class="f-desc">${descHtml}</div></div>
            </div>`;
          }
          return `<div class="fault ${sevClass}">
            <ha-icon class="sev" icon="${sevIcon}" title="${sevTitle}"></ha-icon>
            <div class="f-main">
              <div class="f-desc">${descHtml}</div>
              <div class="f-meta">
                ${codeChip}
                <span class="chip" title="${srcTitle}">${f.src}</span>
                <span>${f.date}</span>
                <span>${f.time}</span>
                ${f.count && f.count !== "1" ? `<span class="chip x" title="Occurred ${f.count} times">×${f.count}</span>` : ""}
              </div>
            </div>
          </div>`;
        })
        .join("");
    }

    const faultCount = faults.filter((f) => f.severity === "FAULT").length;
    const noticeCount = faults.length - faultCount;
    const faultBadges =
      `<span class="counts">` +
      (faultCount ? `<span class="badge badge-fault">${faultCount} fault${faultCount > 1 ? "s" : ""}</span>` : "") +
      (noticeCount ? `<span class="badge badge-notice">${noticeCount} notice${noticeCount > 1 ? "s" : ""}</span>` : "") +
      `</span>`;

    // Chart panel belongs to whichever section owns the expanded metric.
    const chart = this._chartPanel();
    const zones = this._config.zones || [];
    const zoneIds = [];
    zones.forEach((z) => {
      const rz = ZONE_ENTITY_IDS(this._hass, z, this._prefix);
      zoneIds.push(rz.temp, rz.humidity, rz.heat_target, rz.cool_target);
      if (this._damperGraphable(rz.damper)) zoneIds.push(rz.damper);
    });
    const outdoorOwns = this._sectionEntityIds("odu").includes(this._chart.entity);
    const indoorOwns = this._sectionEntityIds("idu").includes(this._chart.entity);
    const zoneOwns = zoneIds.includes(this._chart.entity);
    const outdoorExtra = outdoorOwns ? chart : "";
    const indoorExtra = indoorOwns ? chart : "";

    // Zoning section (only when zones are configured)
    let zoningSection = "";
    if (zones.length) {
      const zoneRows = `<div class="zones-list">${zones.map((z) => this._zoneRow(z)).join("")}</div>`;
      zoningSection = this._section(
        `<span><ha-icon class="sec-ic" icon="mdi:view-dashboard-outline"></ha-icon> Zoning ${this._modelChip(e.zoning_model)}</span>`,
        "",
        zoneRows,
        zoneOwns ? chart : ""
      );
    }

    this.innerHTML = `
      ${this._styles()}
      <ha-card>
        <div class="header">
          <ha-icon icon="mdi:hvac"></ha-icon>
          <span class="title">${this._config.title}</span>
        </div>

        ${this._section(`<span><ha-icon class="sec-ic" icon="mdi:heat-pump-outline"></ha-icon> Outdoor Unit ${this._modelChip(e.odu_model)}</span>`, "", outdoor, outdoorExtra)}
        ${this._section(`<span><ha-icon class="sec-ic" icon="mdi:fan"></ha-icon> Air Handler ${this._modelChip(e.furnace_model)}</span>`, "", indoor, indoorExtra)}
        ${zoningSection}

        <div class="section">
          <div class="section-label"><span><ha-icon class="sec-ic" icon="mdi:alert-outline"></ha-icon> Fault History</span>${faultBadges}</div>
          <div class="faults">${faultRows}</div>
        </div>
      </ha-card>`;

    if (this._chart.entity) this._renderChart();
  }

  _styles() {
    return `<style>
      ha-card { padding: 16px; }
      .header { display:flex; align-items:center; gap:8px; font-size:1.2rem; font-weight:600; margin-bottom:6px; }
      .header ha-icon { color: var(--state-icon-color, var(--primary-color)); }

      .section {
        border:1px solid var(--divider-color); border-radius:14px;
        padding:10px 12px 12px; margin-top:12px;
        background: color-mix(in srgb, var(--secondary-background-color) 45%, transparent);
      }
      .section-label {
        display:flex; align-items:center; justify-content:space-between;
        text-transform:uppercase; letter-spacing:.06em; font-size:.74rem; font-weight:600;
        color: var(--secondary-text-color); margin-bottom:10px;
      }
      .section-label .sec-ic { --mdc-icon-size:18px; vertical-align:-4px; margin-right:2px; color: var(--primary-color); }
      .sec-model { text-transform:none; letter-spacing:0; font-weight:600; font-size:.72rem; color: var(--primary-text-color); background: var(--divider-color); border-radius:8px; padding:1px 8px; font-family: var(--code-font-family, monospace); text-decoration:none; display:inline-flex; align-items:center; gap:3px; }
      .sec-model:hover { color: var(--primary-color); }
      .sec-model .ext { --mdc-icon-size:12px; opacity:.5; }
      .sec-model:hover .ext { opacity:1; }
      .counts { display:flex; align-items:center; gap:6px; }
      .badge { display:inline-flex; align-items:center; justify-content:center; height:20px; box-sizing:border-box; line-height:1; font-size:.7rem; padding:0 9px; border-radius:10px; font-weight:600; white-space:nowrap; }
      .badge.badge-fault { background: var(--error-color, #db4437); color:#fff; }
      .badge.badge-notice { background: var(--warning-color, #ffa600); color:#222; }

      .metrics { display:grid; gap:10px; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
      .tile { display:flex; align-items:center; gap:10px; background: var(--card-background-color); border-radius:12px; padding:10px 12px; box-shadow: var(--ha-card-box-shadow, none); }
      .tile ha-icon { color: var(--state-icon-color, var(--primary-color)); --mdc-icon-size:26px; flex:0 0 auto; }
      .tile .tile-body { min-width:0; }
      .tile.clickable { cursor:pointer; transition: outline-color .12s ease; outline:2px solid transparent; }
      .tile.clickable:hover { outline-color: color-mix(in srgb, var(--primary-color) 45%, transparent); }
      .tile.open { outline:2px solid var(--primary-color); }
      .tile .g-ic { --mdc-icon-size:15px; color: var(--secondary-text-color); opacity:.35; margin-left:auto; }
      .tile.clickable:hover .g-ic, .tile.open .g-ic { opacity:.85; color: var(--primary-color); }
      .tile.accent-green ha-icon { color: var(--success-color, #43a047); }
      .tile.accent-gray ha-icon { color: var(--disabled-text-color, #9e9e9e); }
      .tile.accent-blue ha-icon { color: var(--info-color, #039be5); }
      .tile-value { font-size:1.35rem; font-weight:600; line-height:1.1; white-space:nowrap; }
      .tile-value .unit { font-size:.72rem; font-weight:400; color: var(--secondary-text-color); margin-left:3px; }
      .tile-label { font-size:.72rem; color: var(--secondary-text-color); white-space:nowrap; }

      /* zoning */
      .zones-list { grid-column: 1 / -1; display:flex; flex-direction:column; gap:12px; }
      .zone .zone-head { font-weight:600; font-size:.9rem; margin:0 2px 7px; color: var(--primary-text-color); }
      .zone-metrics { display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
      .zone-metric { display:flex; align-items:center; gap:9px; min-width:0; background: var(--card-background-color); border-radius:12px; padding:8px 11px; box-shadow: var(--ha-card-box-shadow, none); outline:2px solid transparent; }
      .zone-metric ha-icon { --mdc-icon-size:24px; color: var(--state-icon-color, var(--primary-color)); flex:0 0 auto; }
      .zone-metric .zm-body { display:flex; flex-direction:column; line-height:1.15; min-width:0; flex:1; }
      .zone-metric .zm-val { font-size:1.05rem; font-weight:600; white-space:nowrap; }
      .zone-metric .zm-label { font-size:.7rem; color: var(--secondary-text-color); white-space:nowrap; }
      .zone-metric.damper .zm-label { margin-top:5px; }
      .zone-metric.clickable { cursor:pointer; transition: outline-color .12s ease; }
      .zone-metric.clickable:hover { outline-color: color-mix(in srgb, var(--primary-color) 45%, transparent); }
      .zone-metric.clickable:hover ha-icon { color: var(--primary-color); }
      .zone-metric .g-ic { --mdc-icon-size:14px; color: var(--secondary-text-color); opacity:.35; flex:0 0 auto; margin-left:auto; align-self:flex-start; }
      .zone-metric.clickable:hover .g-ic { opacity:.85; color: var(--primary-color); }
      .zone-metric.setpoint .zm-body { flex-direction:row; align-items:center; gap:10px; }
      .zone-metric.setpoint .zm-text { display:flex; flex-direction:column; line-height:1.15; min-width:0; }
      .sp-edit { flex:0 0 auto; width:32px; height:32px; border-radius:9px; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; padding:0; background: color-mix(in srgb, var(--sp-edit-accent) 20%, transparent); color: var(--sp-edit-accent); transition: background .12s ease, color .12s ease, transform .06s ease; }
      .sp-edit.heat { --sp-edit-accent: #e5484d; }
      .sp-edit.cool { --sp-edit-accent: #2f7de5; }
      .sp-edit ha-icon { --mdc-icon-size:19px; color: inherit; }
      .sp-edit:hover { background: var(--sp-edit-accent); color:#fff; }
      .sp-edit:active { transform: translateY(1px); }
      .dmeter { position:relative; width:100%; height:22px; border-radius:6px; background: var(--divider-color); overflow:hidden; box-sizing:border-box; }
      .dmeter.empty { display:flex; align-items:center; justify-content:center; color: var(--secondary-text-color); background:transparent; }
      .dmeter .dfill { position:absolute; left:0; top:0; bottom:0; background: var(--info-color, #039be5); }
      .dmeter .dtext { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:.78rem; font-weight:600; color: var(--primary-text-color); text-shadow:0 0 2px var(--card-background-color); }

      /* Interactive select controls (fan mode / profile / system mode). */
      .inf-select {
        appearance:none; -webkit-appearance:none; -moz-appearance:none;
        font:inherit; font-size:.98rem; font-weight:600; color: var(--primary-text-color);
        background: var(--secondary-background-color);
        border:1px solid var(--divider-color); border-radius:9px;
        padding:5px 26px 5px 9px; cursor:pointer; width:100%; box-sizing:border-box;
        line-height:1.2; max-width:100%;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24'%3E%3Cpath fill='%23888' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
        background-repeat:no-repeat; background-position:right 5px center;
        transition: border-color .12s ease, background-color .12s ease;
      }
      .inf-select:hover { border-color: color-mix(in srgb, var(--primary-color) 55%, var(--divider-color)); }
      .inf-select:focus { outline:none; border-color: var(--primary-color); }
      .inf-select.heat { color:#e5484d; }
      .inf-select.cool { color:#2f7de5; }
      .zone-metric.zselect .zm-body { gap:5px; }
      .tile.tile-select .tile-body { flex:1; min-width:0; }
      .tile.tile-select .inf-select { margin-bottom:3px; }

      .faults { display:flex; flex-direction:column; gap:6px; max-height:340px; overflow-y:auto; padding-right:4px; scrollbar-width:thin; }
      .faults::-webkit-scrollbar { width:8px; }
      .faults::-webkit-scrollbar-thumb { background: var(--divider-color); border-radius:8px; }
      .no-faults { display:flex; align-items:center; gap:8px; color: var(--success-color, #43a047); padding:6px 0; }
      .retrieving { display:flex; align-items:center; gap:8px; color: var(--secondary-text-color); padding:6px 0; font-style: italic; }
      .retrieving .spin { animation: infsp-spin 1.4s linear infinite; }
      @keyframes infsp-spin { to { transform: rotate(360deg); } }
      .fault { display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border-radius:10px; background: var(--card-background-color); border-left:4px solid var(--divider-color); }
      .fault.sev-fault { border-left-color: var(--error-color, #db4437); }
      .fault.sev-notice { border-left-color: var(--warning-color, #ffa600); }
      .fault .sev { --mdc-icon-size:20px; margin-top:2px; cursor:help; }
      .fault.sev-fault .sev { color: var(--error-color, #db4437); }
      .fault.sev-notice .sev { color: var(--warning-color, #ffa600); }
      .f-main { flex:1; min-width:0; }
      .f-desc { font-weight:600; font-size:.92rem; }
      .f-link { color: inherit; text-decoration: none; display:inline-flex; align-items:center; gap:4px; }
      .f-link:hover { text-decoration: underline; color: var(--primary-color); }
      .f-link .ext { --mdc-icon-size:14px; opacity:.55; }
      .f-link:hover .ext { opacity:1; }
      .f-code { font-weight:400; color: var(--secondary-text-color); font-size:.8rem; }
      .chip.code { background: color-mix(in srgb, var(--primary-color) 22%, transparent); color: var(--primary-text-color); font-weight:600; }
      .f-meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:2px; font-size:.78rem; color: var(--secondary-text-color); align-items:center; }
      .chip { background: var(--divider-color); border-radius:8px; padding:0 7px; font-size:.72rem; cursor:help; }
      .chip.x { background: var(--error-color, #db4437); color:#fff; }

      /* expandable history chart */
      .chart-wrap { margin-top:10px; padding-top:8px; border-top:1px dashed var(--divider-color); }
      .chart-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
      .chart-title { flex:1; font-size:.72rem; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color: var(--secondary-text-color); }
      .chart-ranges { display:flex; gap:3px; }
      .range-btn { border:1px solid var(--divider-color); background:transparent; color: var(--secondary-text-color); font:inherit; font-size:.7rem; padding:1px 8px; border-radius:8px; cursor:pointer; }
      .range-btn:hover { border-color: var(--primary-color); color: var(--primary-color); }
      .range-btn.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
      .chart-close { --mdc-icon-size:18px; cursor:pointer; color: var(--secondary-text-color); }
      .chart-close:hover { color: var(--primary-color); }
      .chart-expand { --mdc-icon-size:18px; cursor:pointer; color: var(--secondary-text-color); }
      .chart-expand:hover { color: var(--primary-color); }
      .chart-body { width:100%; min-height:120px; }
      .chart-msg { color: var(--secondary-text-color); font-size:.8rem; padding:36px 0; text-align:center; }
      .spark { width:100%; height:auto; display:block; }
      .spark .line { fill:none; stroke: var(--primary-color); stroke-width:2; vector-effect:non-scaling-stroke; }
      .spark .area { fill: var(--primary-color); opacity:.12; stroke:none; }
      .spark .grid { stroke: var(--divider-color); stroke-width:1; vector-effect:non-scaling-stroke; opacity:.6; }
      .spark .lbl { fill: var(--secondary-text-color); font-size:10px; }
      .spark .cur { fill: var(--primary-text-color); font-size:11px; font-weight:600; }
      .spark .dot { fill: var(--primary-color); }
      .spark.big { cursor: crosshair; }
      .spark .xhair .xh-line { stroke: var(--primary-color); stroke-width:1; stroke-dasharray:4 3; vector-effect:non-scaling-stroke; opacity:.7; }
      .spark .xhair .xh-dot { fill: var(--primary-color); stroke: var(--card-background-color); stroke-width:1.5; }
    </style>`;
  }

  _modalStyles() {
    return `<style>
      .infsp-modal-root { position: fixed; inset: 0; z-index: 9999; }
      .infsp-modal-root .modal-backdrop { position:absolute; inset:0; background: rgba(0,0,0,.55); backdrop-filter: blur(2px); }
      .infsp-modal-root .modal-box {
        position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
        width:min(1000px, 94vw); max-height:92vh; overflow:auto;
        background: var(--ha-card-background, var(--card-background-color, #fff));
        color: var(--primary-text-color); border-radius:16px; padding:16px 18px 12px;
        box-shadow: 0 12px 48px rgba(0,0,0,.45); border:1px solid var(--divider-color);
      }
      .infsp-modal-root .modal-head { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
      .infsp-modal-root .modal-title { flex:1; font-size:1rem; font-weight:600; }
      .infsp-modal-root .modal-ranges { display:flex; gap:4px; flex-wrap:wrap; }
      .infsp-modal-root .range-btn { border:1px solid var(--divider-color); background:transparent; color: var(--secondary-text-color); font:inherit; font-size:.78rem; padding:2px 10px; border-radius:8px; cursor:pointer; }
      .infsp-modal-root .range-btn:hover { border-color: var(--primary-color); color: var(--primary-color); }
      .infsp-modal-root .range-btn.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
      .infsp-modal-root [data-modal-close].mdi, .infsp-modal-root ha-icon[data-modal-close] { --mdc-icon-size:22px; cursor:pointer; color: var(--secondary-text-color); }
      .infsp-modal-root ha-icon[data-modal-close]:hover { color: var(--primary-color); }
      .infsp-modal-root .modal-chart { position:relative; width:100%; }
      .infsp-modal-root .modal-hint { margin-top:6px; font-size:.72rem; color: var(--secondary-text-color); text-align:center; }
      .infsp-modal-root .chart-msg { color: var(--secondary-text-color); font-size:.9rem; padding:80px 0; text-align:center; }
      .infsp-modal-root .spark { width:100%; height:auto; display:block; }
      .infsp-modal-root .spark.big { cursor: crosshair; }
      .infsp-modal-root .spark .line { fill:none; stroke: var(--primary-color); stroke-width:2; vector-effect:non-scaling-stroke; }
      .infsp-modal-root .spark .area { fill: var(--primary-color); opacity:.12; stroke:none; }
      .infsp-modal-root .spark .grid { stroke: var(--divider-color); stroke-width:1; vector-effect:non-scaling-stroke; opacity:.6; }
      .infsp-modal-root .spark .lbl { fill: var(--secondary-text-color); font-size:10px; }
      .infsp-modal-root .spark .cur { fill: var(--primary-text-color); font-size:11px; font-weight:600; }
      .infsp-modal-root .spark .dot { fill: var(--primary-color); }
      .infsp-modal-root .spark .xhair .xh-line { stroke: var(--primary-color); stroke-width:1; stroke-dasharray:4 3; vector-effect:non-scaling-stroke; opacity:.8; }
      .infsp-modal-root .spark .xhair .xh-dot { fill: var(--primary-color); stroke: var(--card-background-color); stroke-width:1.5; }
      .infsp-modal-root .xh-tip {
        position:absolute; pointer-events:none; z-index:2; white-space:nowrap;
        background: var(--card-background-color); border:1px solid var(--divider-color);
        border-radius:8px; padding:4px 8px; box-shadow:0 2px 10px rgba(0,0,0,.25);
        display:flex; flex-direction:column; line-height:1.25;
      }
      .infsp-modal-root .xh-tip b { font-size:.92rem; }
      .infsp-modal-root .xh-tip span { font-size:.72rem; color: var(--secondary-text-color); }
    </style>`;
  }

  _setpointStyles() {
    return `<style>
      .infsp-sp-root .sp-box { width:min(320px, 92vw); padding:18px 20px 16px; --sp-accent: var(--primary-color); }
      .infsp-sp-root .sp-box.heat { --sp-accent: #e5484d; }
      .infsp-sp-root .sp-box.cool { --sp-accent: #2f7de5; }
      .infsp-sp-root .sp-body { display:flex; flex-direction:column; align-items:center; gap:16px; padding:8px 0 4px; }
      .infsp-sp-root .sp-reading { display:flex; align-items:baseline; justify-content:center; gap:3px; }
      .infsp-sp-root .sp-num { font-size:2.8rem; font-weight:700; line-height:1; color: var(--sp-accent); }
      .infsp-sp-root .sp-unit { font-size:1.15rem; font-weight:600; color: var(--secondary-text-color); }
      .infsp-sp-root .sp-adjust { display:flex; flex-direction:column; align-items:center; gap:12px; }
      .infsp-sp-root .sp-slider { display:flex; flex-direction:column; align-items:center; gap:6px; }
      .infsp-sp-root .sp-max, .infsp-sp-root .sp-min { font-size:.72rem; color: var(--secondary-text-color); }
      .infsp-sp-root .sp-track { position:relative; width:46px; height:200px; border-radius:23px; background: var(--divider-color); cursor:pointer; touch-action:none; }
      .infsp-sp-root .sp-fill { position:absolute; left:0; right:0; bottom:0; border-radius:23px; background: linear-gradient(0deg, var(--sp-accent), color-mix(in srgb, var(--sp-accent) 55%, #fff)); }
      .infsp-sp-root .sp-thumb { position:absolute; left:50%; width:54px; height:54px; border-radius:50%; transform:translate(-50%,50%); background: var(--card-background-color); border:4px solid var(--sp-accent); box-shadow:0 2px 10px rgba(0,0,0,.4); cursor:grab; pointer-events:none; }
      .infsp-sp-root .sp-nudge { width:46px; height:42px; border-radius:12px; border:none; cursor:pointer; font-size:1.5rem; font-weight:700; line-height:1; color: var(--primary-text-color); background: var(--divider-color); transition: background .12s ease, color .12s ease; }
      .infsp-sp-root .sp-nudge:hover { background: color-mix(in srgb, var(--sp-accent) 40%, var(--divider-color)); color: var(--sp-accent); }
      .infsp-sp-root .sp-nudge:active { transform: translateY(1px); }
      .infsp-sp-root .sp-actions { display:flex; gap:10px; margin-top:18px; }
      .infsp-sp-root .sp-act { flex:1; padding:11px 0; border-radius:12px; border:none; font:inherit; font-size:.95rem; font-weight:600; cursor:pointer; transition: background .12s ease, opacity .12s ease; }
      .infsp-sp-root .sp-act.cancel { background: var(--divider-color); color: var(--primary-text-color); }
      .infsp-sp-root .sp-act.cancel:hover { background: color-mix(in srgb, var(--error-color, #db4437) 22%, var(--divider-color)); }
      .infsp-sp-root .sp-act.apply { background: color-mix(in srgb, var(--sp-accent) 28%, var(--divider-color)); color: var(--secondary-text-color); }
      .infsp-sp-root .sp-act.apply.on { background: var(--sp-accent); color:#fff; }
      .infsp-sp-root .sp-act[disabled] { cursor:default; opacity:.55; }
    </style>`;
  }


  getCardSize() {
    return this._chart && this._chart.entity ? 10 : 7;
  }

  static getConfigElement() {
    return document.createElement("infinitesp-card-editor");
  }

  static getStubConfig() {
    return {
      title: "Carrier Infinity",
      // Just the ESPHome node name — the card derives every entity id AND
      // auto-discovers zones from it. Pick the device in the editor to switch
      // to a stable device_id.
      device: "infinitesp-dev",
    };
  }
}

customElements.define("infinitesp-card", InfinitespCard);

// ---- visual config editor (entity selection + temperature unit) -----------
// Coefficient tuning is intentionally NOT exposed here; edit YAML for that.
const EDITOR_LABELS = {
  title: "Card title",
  device_id: "ESPHome device",
  temperature_unit: "Temperature unit",
  outdoor_temp: "Outdoor temperature (override)",
  coil_temp: "Coil temperature (override)",
  stage: "Compressor stage (override)",
  line_voltage: "Line voltage (override)",
  airflow: "Airflow (CFM) (override)",
  blower_rpm: "Blower (RPM) (override)",
  blower_watts: "Blower power (W) (override)",
  static_pressure: "Static pressure (override)",
  system_mode: "System mode select (override)",
  odu_model: "Outdoor unit model (override)",
  furnace_model: "Furnace / air-handler model (override)",
  zoning_model: "Zoning board model (override)",
};

const ZONE_FORM_LABELS = {
  name: "Zone name",
  temp: "Temperature",
  humidity: "Humidity",
  damper: "Damper",
};

class InfinitespCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) {
      this._form.hass = hass;
      // The hub dropdown options depend on hass; rebuild the schema when the set
      // of hub devices changes (not every tick, to avoid disrupting interaction).
      const sig = this._hubDevices().map((o) => o.value).join(",");
      if (sig !== this._devSig) {
        this._devSig = sig;
        this._form.schema = this._schema();
      }
    }
    if (this._overrideForm) this._overrideForm.hass = hass;
  }

  // Top-level ESPHome devices (hubs) only — exclude zone sub-devices, which carry
  // a `via_device_id` pointing at their hub. Returns [{value: id, label}] for a
  // `select` selector. HA can't natively filter the device picker by our
  // component or by device hierarchy, so we derive the list here.
  _hubDevices() {
    const hass = this._hass;
    if (!hass || !hass.devices) return [];
    const isEsphome = (d) =>
      Array.isArray(d.identifiers) &&
      d.identifiers.some((i) => Array.isArray(i) && i[0] === "esphome");
    return Object.keys(hass.devices)
      .map((id) => hass.devices[id])
      .filter((d) => d && !d.via_device_id && isEsphome(d))
      .map((d) => ({ value: d.id, label: d.name_by_user || d.name || d.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  _schema() {
    return [
      { name: "title", selector: { text: {} } },
      // Only top-level ESPHome nodes (hubs) should be selectable — NOT the
      // per-zone sub-devices (which are real ESPHome devices too). HA has no
      // notion of an ESPHome *component* (everything is the `esphome`
      // integration), and its device selector can't filter on the device
      // hierarchy, so we build the list ourselves from the canonical signal:
      // a sub-device has `via_device_id` set; a hub does not.
      {
        name: "device_id",
        selector: { select: { mode: "dropdown", options: this._hubDevices() } },
      },
      {
        name: "temperature_unit",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "F", label: "Fahrenheit (°F)" },
              { value: "C", label: "Celsius (°C)" },
            ],
          },
        },
      },
    ];
  }

  // Entity-override selectors live in a collapsed panel — most users only set
  // `device` and never touch these.
  _overrideSchema() {
    return [
      { name: "outdoor_temp", selector: { entity: { domain: "sensor" } } },
      { name: "coil_temp", selector: { entity: { domain: "sensor" } } },
      { name: "stage", selector: { entity: { domain: "sensor" } } },
      { name: "line_voltage", selector: { entity: { domain: "sensor" } } },
      { name: "airflow", selector: { entity: { domain: "sensor" } } },
      { name: "blower_rpm", selector: { entity: { domain: "sensor" } } },
      { name: "blower_watts", selector: { entity: { domain: "sensor" } } },
      { name: "static_pressure", selector: { entity: { domain: "sensor" } } },
      { name: "odu_model", selector: { entity: { domain: "sensor" } } },
      { name: "furnace_model", selector: { entity: { domain: "sensor" } } },
      { name: "zoning_model", selector: { entity: { domain: "sensor" } } },
    ];
  }

  // Current ordered feature keys for a section (config or defaults).
  _secList(section) {
    const valid = SECTION_KEYS(section);
    const cfg = (this._config.sections || {})[section];
    if (Array.isArray(cfg)) return cfg.filter((k) => valid.includes(k));
    return DEFAULT_SECTIONS[section].slice();
  }

  _featLabel(section, key) {
    return section === "zoning" ? (ZONE_METRICS[key] || {}).label || key : (FEATURES[key] || {}).label || key;
  }

  _featIcon(section, key) {
    return section === "zoning" ? (ZONE_METRICS[key] || {}).icon || "mdi:tune" : (FEATURES[key] || {}).icon || "mdi:tune";
  }

  _render() {
    if (!this._form) {
      // Main options.
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => this._valueChanged(ev));
      this.appendChild(this._form);

      // Per-section feature editors (add / remove / drag-reorder).
      this._sectionsRoot = document.createElement("div");
      this._sectionsRoot.addEventListener("click", (ev) => this._onSectionsClick(ev));
      this._sectionsRoot.addEventListener("change", (ev) => this._onSectionsChange(ev));
      this.appendChild(this._sectionsRoot);

      // Zones editor (detect from device / add / remove / drag-reorder + overrides).
      this._zonesRoot = document.createElement("div");
      this._zonesRoot.addEventListener("click", (ev) => this._onZonesClick(ev));
      this.appendChild(this._zonesRoot);

      // Collapsed entity overrides.
      this._overridePanel = document.createElement("ha-expansion-panel");
      this._overridePanel.header = "Entity overrides (optional)";
      this._overrideForm = document.createElement("ha-form");
      this._overrideForm.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._overrideForm.addEventListener("value-changed", (ev) => this._valueChanged(ev));
      this._overridePanel.appendChild(this._overrideForm);
      this.appendChild(this._overridePanel);
    }
    const e = this._config.entities || {};
    if (this._hass) {
      this._form.hass = this._hass;
      this._overrideForm.hass = this._hass;
    }
    this._form.schema = this._schema();
    this._form.data = {
      title: this._config.title || "",
      device_id: this._config.device_id || "",
      temperature_unit: this._config.temperature_unit || "F",
    };
    this._overrideForm.schema = this._overrideSchema();
    this._overrideForm.data = {
      outdoor_temp: e.outdoor_temp || "",
      coil_temp: e.coil_temp || "",
      stage: e.stage || "",
      line_voltage: e.line_voltage || "",
      airflow: e.airflow || "",
      blower_rpm: e.blower_rpm || "",
      blower_watts: e.blower_watts || "",
      static_pressure: e.static_pressure || "",
      odu_model: e.odu_model || "",
      furnace_model: e.furnace_model || "",
      zoning_model: e.zoning_model || "",
    };
    this._renderSections();
    this._renderZones();
  }

  _sectionEditorHtml(section, title) {
    const active = this._secList(section);
    const inactive = SECTION_KEYS(section).filter((k) => !active.includes(k));
    const rows = active
      .map(
        (k) => `
        <div class="feat-row" data-key="${k}">
          <ha-icon class="handle" icon="mdi:drag"></ha-icon>
          <ha-icon class="f-ic" icon="${this._featIcon(section, k)}"></ha-icon>
          <span class="f-label">${this._featLabel(section, k)}</span>
          <ha-icon-button class="remove" data-section="${section}" data-key="${k}" title="Remove">
            <ha-icon icon="mdi:close"></ha-icon>
          </ha-icon-button>
        </div>`
      )
      .join("");
    const addOptions = inactive
      .map((k) => `<option value="${k}">${this._featLabel(section, k)}</option>`)
      .join("");
    const addControl = inactive.length
      ? `<select class="feat-add" data-section="${section}">
           <option value="">+ Add feature…</option>${addOptions}
         </select>`
      : `<span class="feat-add-empty">All features added</span>`;
    return `
      <div class="feat-section">
        <div class="feat-title">${title}</div>
        <ha-sortable handle-selector=".handle" data-section="${section}">
          <div class="feat-list">${rows || `<div class="feat-empty">No features — add one below</div>`}</div>
        </ha-sortable>
        <div class="feat-add-row">${addControl}</div>
      </div>`;
  }

  _renderSections() {
    this._sectionsRoot.innerHTML = `
      <style>
        .feat-section { margin-top: 14px; }
        .feat-title { font-weight: 600; font-size: .95rem; margin: 0 0 6px 2px; }
        .feat-list { display: flex; flex-direction: column; gap: 6px; }
        .feat-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px;
          border: 1px solid var(--divider-color); border-radius: 8px;
          background: var(--card-background-color); }
        .feat-row .handle { cursor: grab; color: var(--secondary-text-color); --mdc-icon-size: 20px; }
        .feat-row .f-ic { color: var(--primary-color); --mdc-icon-size: 20px; }
        .feat-row .f-label { flex: 1; }
        .feat-row .remove { color: var(--secondary-text-color); --mdc-icon-size: 18px; margin-left: auto; }
        .feat-empty, .feat-add-empty { color: var(--secondary-text-color); font-size: .85rem; padding: 4px 2px; }
        .feat-add-row { margin-top: 6px; }
        .feat-add { padding: 6px 8px; border-radius: 8px; border: 1px solid var(--divider-color);
          background: var(--card-background-color); color: var(--primary-text-color); }
        .sortable-ghost { opacity: .4; }
      </style>
      ${this._sectionEditorHtml("odu", "Outdoor Unit features")}
      ${this._sectionEditorHtml("idu", "Air Handler features")}
      ${this._sectionEditorHtml("zoning", "Zoning metrics")}`;
    // ha-sortable's item-moved event doesn't bubble reliably — bind per element.
    this._sectionsRoot.querySelectorAll("ha-sortable").forEach((el) => {
      el.addEventListener("item-moved", (ev) => {
        ev.stopPropagation();
        const section = el.getAttribute("data-section");
        this._moveFeature(section, ev.detail.oldIndex, ev.detail.newIndex);
      });
    });
  }

  _onSectionsClick(ev) {
    const rm = ev.target.closest && ev.target.closest(".remove");
    if (rm) {
      this._setSection(rm.getAttribute("data-section"),
        this._secList(rm.getAttribute("data-section")).filter((k) => k !== rm.getAttribute("data-key")));
    }
  }

  _onSectionsChange(ev) {
    const sel = ev.target.closest && ev.target.closest(".feat-add");
    if (sel && sel.value) {
      const section = sel.getAttribute("data-section");
      this._setSection(section, this._secList(section).concat(sel.value));
    }
  }

  _moveFeature(section, from, to) {
    const list = this._secList(section);
    if (from == null || to == null || from === to) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    this._setSection(section, list);
  }

  _setSection(section, list) {
    const sections = Object.assign({}, this._config.sections, { [section]: list });
    this._emit(Object.assign({}, this._config, { sections }));
    this._renderSections();
  }

  // ---- zones sub-editor ----------------------------------------------------

  _zones() {
    return (this._config.zones || []).map((z) => Object.assign({}, z));
  }

  _zoneNameSchema() {
    return [{ name: "name", selector: { text: {} } }];
  }

  _zoneOverrideSchema() {
    return [
      { name: "temp", selector: { entity: { domain: "sensor" } } },
      { name: "humidity", selector: { entity: { domain: "sensor" } } },
      { name: "damper", selector: { entity: { domain: ["sensor", "cover"] } } },
    ];
  }

  _renderZones() {
    const zones = this._zones();
    if (!this._zoneForms) this._zoneForms = [];
    // Rebuild the structure only when the zone count changes or a structural
    // edit marked it dirty — this preserves caret/focus while typing a name.
    if (!this._zonesBuilt || this._zoneForms.length !== zones.length || this._zonesDirty) {
      this._zonesDirty = false;
      this._zonesBuilt = true;
      this._zoneForms = [];
      this._zoneOverrideForms = [];
      this._zoneNameEls = [];
      this._zonesRoot.innerHTML = "";
      const head = document.createElement("div");
      head.innerHTML = `
        <style>
          .zed-title { font-weight:600; font-size:.95rem; margin:14px 0 6px 2px; }
          .zed-tools { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
          .zed-btn { padding:6px 10px; border-radius:8px; border:1px solid var(--divider-color);
            background: var(--card-background-color); color: var(--primary-text-color); cursor:pointer; font-size:.85rem; }
          .zed-btn:hover { border-color: var(--primary-color); color: var(--primary-color); }
          .zed-hint { color: var(--secondary-text-color); font-size:.8rem; margin:0 0 8px 2px; }
          .zed-list { display:flex; flex-direction:column; gap:10px; }
          .zed-row { border:1px solid var(--divider-color); border-radius:10px; padding:8px 10px;
            background: color-mix(in srgb, var(--secondary-background-color) 35%, transparent); }
          .zed-row-head { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
          .zed-row-head .zhandle { cursor:grab; color: var(--secondary-text-color); --mdc-icon-size:20px; }
          .zed-row-head .zed-name { flex:1; font-weight:600; }
          .zed-row-head .zed-remove { color: var(--secondary-text-color); --mdc-icon-size:18px; margin-left:auto; }
          .zed-empty { color: var(--secondary-text-color); font-size:.85rem; padding:4px 2px; }
        </style>
        <div class="zed-title">Zones</div>
        <div class="zed-tools">
          <button class="zed-btn zed-detect" type="button">Detect zones from device</button>
          <button class="zed-btn zed-add" type="button">+ Add zone</button>
        </div>
        <div class="zed-hint">Detect reads the ESPHome device's climate entities and deduces each zone's sensors — override any below.</div>`;
      this._zonesRoot.appendChild(head);

      const sortable = document.createElement("ha-sortable");
      sortable.setAttribute("handle-selector", ".zhandle");
      const list = document.createElement("div");
      list.className = "zed-list";
      if (!zones.length) {
        const empty = document.createElement("div");
        empty.className = "zed-empty";
        empty.textContent = "No zones — click “Detect zones from device” or “Add zone”.";
        list.appendChild(empty);
      }
      sortable.appendChild(list);
      this._zonesRoot.appendChild(sortable);
      sortable.addEventListener("item-moved", (ev) => {
        ev.stopPropagation();
        this._moveZone(ev.detail.oldIndex, ev.detail.newIndex);
      });

      zones.forEach((z, i) => {
        const row = document.createElement("div");
        row.className = "zed-row";
        const rhead = document.createElement("div");
        rhead.className = "zed-row-head";
        rhead.innerHTML = `
          <ha-icon class="zhandle" icon="mdi:drag"></ha-icon>
          <span class="zed-name"></span>
          <ha-icon-button class="zed-remove" data-index="${i}" title="Remove zone">
            <ha-icon icon="mdi:close"></ha-icon>
          </ha-icon-button>`;
        rhead.querySelector(".zed-name").textContent = z.name || `Zone ${i + 1}`;
        this._zoneNameEls.push(rhead.querySelector(".zed-name"));
        row.appendChild(rhead);
        const form = document.createElement("ha-form");
        form.computeLabel = (s) => ZONE_FORM_LABELS[s.name] || s.name;
        form.schema = this._zoneNameSchema();
        form.addEventListener("value-changed", (ev) => this._onZoneFormChange(i, ev));
        row.appendChild(form);
        // Sensor overrides collapse into a panel — deduced from the zone name by
        // default, so most users never open this.
        const panel = document.createElement("ha-expansion-panel");
        panel.header = "Sensor overrides (optional)";
        const oform = document.createElement("ha-form");
        oform.computeLabel = (s) => ZONE_FORM_LABELS[s.name] || s.name;
        oform.schema = this._zoneOverrideSchema();
        oform.addEventListener("value-changed", (ev) => this._onZoneFormChange(i, ev));
        panel.appendChild(oform);
        row.appendChild(panel);
        list.appendChild(row);
        this._zoneForms.push(form);
        this._zoneOverrideForms.push(oform);
      });
    }
    // Refresh data + hass on the (persistent) forms.
    zones.forEach((z, i) => {
      const f = this._zoneForms[i];
      const of = this._zoneOverrideForms[i];
      if (f) {
        if (this._hass) f.hass = this._hass;
        f.data = { name: z.name || "" };
      }
      if (of) {
        if (this._hass) of.hass = this._hass;
        of.data = { temp: z.temp || "", humidity: z.humidity || "", damper: z.damper || "" };
      }
      if (this._zoneNameEls && this._zoneNameEls[i]) this._zoneNameEls[i].textContent = z.name || `Zone ${i + 1}`;
    });
  }

  _onZonesClick(ev) {
    const t = ev.target;
    if (t.closest && t.closest(".zed-detect")) return this._detectZones();
    if (t.closest && t.closest(".zed-add")) return this._addZone();
    const rm = t.closest && t.closest(".zed-remove");
    if (rm) return this._removeZone(parseInt(rm.getAttribute("data-index"), 10));
  }

  _cleanZone(z) {
    const o = { name: z.name || "" };
    if (z.temp) o.temp = z.temp;
    if (z.humidity) o.humidity = z.humidity;
    if (z.damper) o.damper = z.damper;
    return o;
  }

  _detectZones() {
    const prefix = this._config.device ? SLUG(this._config.device) : "";
    const found = discoverZones(this._hass, this._config.device_id, prefix);
    if (!found.length) {
      // Nothing found — surface a lightweight hint without throwing.
      const hint = this._zonesRoot.querySelector(".zed-hint");
      if (hint) hint.textContent = "No zones detected — is the ESPHome device selected and online?";
      return;
    }
    // Store names only; sensor ids are deduced at render time (overridable).
    this._setZones(found.map((z) => ({ name: z.name })), true);
  }

  _addZone() {
    this._setZones(this._zones().concat({ name: `Zone ${this._zones().length + 1}` }), true);
  }

  _removeZone(i) {
    const zones = this._zones();
    if (i < 0 || i >= zones.length) return;
    zones.splice(i, 1);
    this._setZones(zones, true);
  }

  _moveZone(from, to) {
    const zones = this._zones();
    if (from == null || to == null || from === to) return;
    const [item] = zones.splice(from, 1);
    zones.splice(to, 0, item);
    this._setZones(zones, true);
  }

  _onZoneFormChange(i, ev) {
    const d = ev.detail.value || {};
    const zones = this._zones();
    if (i < 0 || i >= zones.length) return;
    // Merge — the name and sensor-override forms fire independently, so a partial
    // update must not drop the other form's values.
    zones[i] = this._cleanZone(Object.assign({}, zones[i], d));
    // Non-structural: don't rebuild (would drop caret); just live-update the header.
    this._setZones(zones, false);
    if (this._zoneNameEls && this._zoneNameEls[i]) this._zoneNameEls[i].textContent = zones[i].name || `Zone ${i + 1}`;
  }

  _setZones(zones, structural) {
    this._emit(Object.assign({}, this._config, { zones }));
    if (structural) {
      this._zonesDirty = true;
      this._renderZones();
    }
  }

  _valueChanged(ev) {
    const d = ev.detail.value || {};
    const entities = Object.assign({}, this._config.entities);
    ["outdoor_temp", "coil_temp", "stage", "line_voltage", "airflow", "blower_rpm", "blower_watts", "static_pressure", "odu_model", "furnace_model", "zoning_model"].forEach((k) => {
      if (k in d) {
        if (d[k]) entities[k] = d[k];
        else delete entities[k];
      }
    });
    const cfg = Object.assign({}, this._config, {
      title: "title" in d ? d.title : this._config.title,
      device_id: "device_id" in d ? d.device_id || undefined : this._config.device_id,
      device: "device" in d ? d.device || undefined : this._config.device,
      temperature_unit: "temperature_unit" in d ? d.temperature_unit : this._config.temperature_unit,
      entities,
    });
    this._emit(cfg);
  }

  // Update local config + notify HA. Deliberately does NOT re-render the ha-forms
  // (that would disrupt typing); section edits call _renderSections() themselves.
  _emit(cfg) {
    this._config = cfg;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: cfg },
        bubbles: true,
        composed: true,
      })
    );
  }
}
customElements.define("infinitesp-card-editor", InfinitespCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "infinitesp-card",
  name: "InfinitESP Card",
  preview: true,
  documentationURL: "https://github.com/nebulous/infinitesp",
  description: "Carrier Infinity outdoor unit, air handler, and zoning metrics with device models and fault history.",
});
