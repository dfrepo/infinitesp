# InfinitESP custom Lovelace card

A single polished card that shows Carrier Infinity **system metrics** and a
color-coded **fault history**, driven by the ESPHome `infinitesp` component.
Metric tiles are **click-to-expand into a history chart**, and the card ships a
**visual config editor** (just enter your ESPHome node name + temperature unit). It has three device
sections — **Outdoor Unit**, **Air Handler**, and **Zoning** — each showing the
device **model** in its header.

![sections: System (tiles) + Fault History (color-coded rows)]

## Install

1. Copy `infinitesp-card.js` into your Home Assistant config: `<config>/www/infinitesp-card.js`
   (create the `www` folder if needed, then restart HA once so it's served under `/local/`).
2. Register it as a dashboard **resource** (Settings → Dashboards → ⋮ → Resources → Add):
   - URL: `/local/infinitesp-card.js`
   - Type: **JavaScript Module**
3. Add the card to a dashboard. You can use the **visual editor** (pick entities + temp unit)
   or paste the YAML below. Enable the `Fault 1..10` entities in HA first
   (they're `disabled_by_default`).

## Card config

Point the card at your ESPHome device and it derives **every** entity id for you.
Two ways:

- **Visual editor (recommended):** pick your ESPHome device in the **ESPHome
  device** field, then click **Detect zones from device** — everything else
  (sensors + zones) is filled in automatically.
- **YAML:** set `device:` to the ESPHome **node name**. Home Assistant builds
  entity ids as `sensor.<node_slug>_<sensor_slug>`, so node `infinitesp-dev`
  gives the prefix `infinitesp_dev`.

```yaml
type: custom:infinitesp-card
title: Carrier Infinity
device: infinitesp-dev     # ESPHome node name -> derives all entity ids
# device_id: abcd1234...   # (editor writes this when you pick the device)
temperature_unit: F        # F or C for the temp tiles
# zones are auto-discovered from the device's climate entities. List them only
# to control names/order or override a sensor. A bare name is enough — the
# temp/humidity/damper sensors are deduced from the zone name (override optional):
# zones:
#   - name: Floor 3
#   - name: Floor 1-2
#     damper: sensor.my_custom_damper   # optional per-metric override
```

The card auto-derives these from the device: outdoor/coil temp, stage, line
voltage, airflow, blower RPM/power, static pressure, the three device models,
`fault_1` … `fault_10`, **and the zones** (each zone surfaces as a climate
entity; its temp/humidity/damper sensors are deduced from the same stem).

Prefer `device_id` (the editor's device picker) when you can — it survives
node renames and Home Assistant's dedup suffixes. Plain `device:` (node name)
works too and needs no entity registry.

### Overriding individual entities

If you renamed an entity in Home Assistant (or a sensor lives on a different
node), list it under `entities:` — an explicit override always wins over the
auto-derived id:

```yaml
entities:
  coil_temp: sensor.my_renamed_coil_temp
faults:                    # only if your fault sensors are named differently
  - sensor.infinitesp_dev_fault_1
```

> Note: ESPHome **text sensors appear under the `sensor.` domain** in Home Assistant,
> so the fault entities are `sensor.…_fault_N` (not `text_sensor.…`).

### Choosing & ordering features per section

Each section shows a default set of tiles. Use the visual editor to **add,
remove, and drag-reorder** the features in the Outdoor Unit, Air Handler, and
Zoning sections — or set them in YAML with `sections:`. Omit a section to keep
its defaults; list it to control exactly what shows and in what order:

```yaml
sections:
  odu: [outdoor_temp, coil_temp, stage, line_voltage]
  idu: [airflow, blower_rpm, blower_watts, static_pressure]
  zoning: [temp, humidity, damper]   # per-zone metric order
```

Available feature keys — **odu:** `outdoor_temp`, `coil_temp`, `stage`,
`line_voltage`; **idu:** `airflow`, `blower_rpm`, `blower_watts`,
`static_pressure`; **zoning:** `temp`, `humidity`, `damper`.



## History charts

Click any metric tile (outdoor/coil temp, stage, line voltage, airflow, blower) to expand an
inline time-series chart drawn from Home Assistant's recorder history. Pick a range
(`1h / 6h / 24h / 3d / 7d`); click the tile again or the ✕ to close. For long-term charts you
need HA's **recorder** enabled for those entities (it is by default).

Use the **⤢ expand** icon on a chart to open a large **interactive popup**: move the cursor over
the plot to get a **crosshair with the exact value and timestamp** at that point. Switch ranges
in the popup, and close with the ✕, the backdrop, or **Esc**.

## Static pressure

Static pressure is a **derived estimate** — the furnace computes the value it displays
internally (from ECM motor torque/current) and doesn't publish it on the bus.

**Preferred: the firmware computes it.** The ESPHome component exposes a `static_pressure`
sensor (`sensor.infinitesp_dev_static_pressure`) using the **watts model**
`SP = static_k · BlowerWatts / CFM` (air power = efficiency × motor power). Validated to ±0.01
vs the thermostat across three points → `static_k = 2.046` (blower efficiency ≈ 24 %). Point the
card's `static_pressure:` entity at it and you get an accurate, **recorded, graphable** value with
no HA template sensor needed. Override the coefficient in your ESPHome YAML if you re-calibrate:

```yaml
sensor:
  - platform: infinitesp
    infinitesp_id: infinitesp_hub
    name: "Static Pressure"
    type: static_pressure
    static_k: 2.046      # optional; SP = static_k * blower_watts / cfm
```

**Fallback: the card computes it.** If no `static_pressure` entity is configured, the card
estimates it in JS, best-to-worst: (1) watts model `static_watts_k · Watts / CFM`, (2) RPM+CFM
power law, (3) CFM-only. This is a live (non-recorded) value. Those card coefficients are not in
the visual editor; override in the card YAML only if needed:

```yaml
static_watts_k: 2.046      # card watts fallback (when no static_pressure entity)
static_k: 0.000027415      # card RPM+CFM fallback
static_rpm_exp: 0.4461
static_cfm_exp: 1.0256
static_k_cfm: 0.0000613    # card CFM-only fallback
static_cfm_only_exp: 1.34
```

**Optional smoothing** (EMA / sliding average). If you want a smoother trace, feed the
firmware `static_pressure` sensor through HA's **Filter** integration:

```yaml
# configuration.yaml
sensor:
  - platform: filter
    name: "Infinity Static Pressure (smoothed)"
    entity_id: sensor.infinitesp_dev_static_pressure
    filters:
      - filter: time_simple_moving_average   # sliding average over a window
        window_size: "00:05"
        precision: 2
      # or, for an exponential moving average instead:
      # - filter: lowpass
      #   time_constant: 10
      #   precision: 2
```

Point `static_pressure:` at `sensor.infinity_static_pressure_smoothed` to graph the smoothed value.

## Notes

- **Stage** decodes the raw `odu_stage` byte (`raw >> 1`): 1→Off, 2→Stage 1, 4→Stage 2.
- **Device models** (ODU/furnace/zoning) come from each device's `0104` DeviceInfo and show in the section headers.
- **Blower Power** is the ECM motor watts (furnace register `0413`) — the load signal the furnace uses to compute static pressure.
- **Zoning** shows each zone's temp/humidity and damper position (0–100%); omit the `zones:` key to hide the section.
- **Temps** convert °C→°F for display when `temperature_unit: F`.
- Faults are color-coded from the firmware's severity flag: red = `FAULT`, amber = `notice`.
- The card uses your theme's CSS variables, so it matches light/dark themes automatically.
