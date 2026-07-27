import esphome.codegen as cg
import esphome.config_validation as cv
import logging
from esphome import pins, core
from esphome.components import uart
from esphome.components import time as time_
from esphome.const import CONF_ID, CONF_TYPE, CONF_DEVICE_ID, CONF_ENTITY_CATEGORY, CONF_NAME, CONF_ICON
from esphome.helpers import fnv1a_32bit_hash

_LOGGER = logging.getLogger(__name__)

Device = cg.esphome_ns.class_("Device")

CODEOWNERS = ["@nebulous"]
DEPENDENCIES = ["uart"]
AUTO_LOAD = ["climate", "sensor", "select", "text_sensor", "binary_sensor", "cover", "number", "time"]
MULTI_CONF = True

CONF_INFINITESP_ID = "infinitesp_id"
CONF_STATUS_LIGHT_ID = "status_light_id"
CONF_STATUS_LED_PIN = "status_led_pin"

infinitesp_ns = cg.esphome_ns.namespace("infinitesp")
InfinitESPComponent = infinitesp_ns.class_("InfinitESPComponent", cg.Component, uart.UARTDevice)
InfinitESPEntity = infinitesp_ns.class_("InfinitESPEntity")

CONF_SAM_ADDRESS = "sam_address"
CONF_ADDRESS = "address"  # deprecated alias for sam_address
CONF_FLOW_CONTROL_PIN = "flow_control_pin"
CONF_TIME_ID = "time_id"
CONF_ZONE_CONTROLLER_ADDRESS = "zone_controller_address"
CONF_TEMPERATURE_UNIT = "temperature_unit"
CONF_ZONES = "zones"
CONF_FAULT_HISTORY = "fault_history"
CONF_AUTO_ZONE_ENTITIES = "auto_zone_entities"
CONF_EXCLUDE_ZONE_ENTITIES = "exclude_zone_entities"

# The full set of fault-history text sensors auto-created when `fault_history:
# true` is set on the hub. Register 0x4202 always holds exactly 10 entries; the
# combined `fault_history` string plus fault_1..fault_10 mirror the explicit
# per-entry sensors — but generated in code so no YAML boilerplate is needed.
_FAULT_TYPES = [f"fault_{i}" for i in range(1, 11)] + ["fault_history"]

# `auto_zone_entities: true` creates every per-zone entity type for every zone,
# DERIVED from the platform type registries (types flagged "zoned": True) plus
# climate/cover (inherently per-zone) — see _auto_zone_specs(). No hardcoded list,
# so a new zoned type is auto-created automatically. Presentation-only extras that
# aren't intrinsic to the type live here, keyed by the entity's tag (type name, or
# the platform name for the typeless climate/cover). The climate/cover/number C++
# sources live in the base component dir so they compile even without a top-level
# section; sensor/select/binary_sensor/text_sensor load via their global entities.
_ZONE_AUTO_EXTRAS = {
    "cover": {"device_class": "damper"},
    "damper_position": {"icon": "mdi:valve", "entity_category": "diagnostic"},
}


def _auto_zone_specs():
    """(platform_name, type_or_None) for every per-zone entity auto-created by
    `auto_zone_entities`: climate + cover, plus each platform type flagged
    "zoned": True (skipping "auto": False types, which are per-zone but
    hardware-specific/opt-in, e.g. zc_zone_temperature). Lazy-imports the platform
    modules (circular at top level)."""
    from . import sensor as _se, number as _nu, select as _sl
    from . import binary_sensor as _bs, text_sensor as _ts
    specs = [("climate", None), ("cover", None)]
    for pname, types in (
        ("sensor", _se.SENSOR_TYPES),
        ("number", _nu.NUMBER_TYPES),
        ("select", _sl.SELECT_TYPES),
        ("binary_sensor", _bs.BINARY_SENSOR_TYPES),
        ("text_sensor", _ts.TEXT_SENSOR_TYPES),
    ):
        for tname, info in types.items():
            if info.get("zoned") and info.get("auto", True):
                specs.append((pname, tname))
    return specs


# Registry of declared zones per hub, populated during validation so entity
# platforms can decide (in their own to_code) whether to auto-attach to a zone
# sub-device. Keyed by the hub's id string.
_HUB_ZONES = {}


def zone_device_id(hub_id, zone):
    """Return a core.ID REFERENCE to the hub's zone sub-device, or None if not
    declared. Accepts hub_id as a resolved core.ID or a raw id string (entity
    platforms call this pre-schema, where infinitesp_id is still a string). The
    returned reference resolves against the declared ID the hub stored in its
    config (see _register_zones). Returns None when the zone isn't declared.
    """
    hub_key = hub_id.id if hasattr(hub_id, "id") else str(hub_id)
    zones = _HUB_ZONES.get(hub_key)
    if not zones or zone not in zones:
        return None
    return core.ID(f"{hub_key}_zone{zone}_dev", is_declaration=False, type=Device)


# YAML key: `zoned: yes` on a per-zone entity type fans it out to every hub zone.
CONF_ZONED = "zoned"


def hub_zone_numbers(hub_id):
    """Return the list of declared zone numbers for a hub (from _HUB_ZONES), or []
    if none. Used by platforms to fan out `zoned: yes` entries across zones."""
    hub_key = hub_id.id if hasattr(hub_id, "id") else str(hub_id)
    return list((_HUB_ZONES.get(hub_key) or {}).keys())


_CONF_ZONE = "zone"  # platforms' per-zone key (also their local CONF_ZONE)


def check_zone_binding(config, is_zoned, kind):
    """Strict zone-binding validator (no defaults), shared by all zone-capable
    platforms: a per-zone type needs exactly one of `zone: N` or `zoned: yes`; a
    global type forbids both. `kind` labels the platform/type in error messages."""
    has_zone = _CONF_ZONE in config
    has_all = bool(config.get(CONF_ZONED))
    if is_zoned:
        if has_zone and has_all:
            raise cv.Invalid(f"{kind}: use either 'zone:' or 'zoned: yes', not both")
        if not has_zone and not has_all:
            raise cv.Invalid(f"{kind} is per-zone; add 'zone: N' or 'zoned: yes'")
    elif has_zone or has_all:
        raise cv.Invalid(f"{kind} is global; remove zone:/zoned:")
    return config


async def codegen_zoned(config, cls, build_one):
    """to_code fan-out: when `zoned: yes`, call build_one once per hub zone — each
    with a zone-unique declared ID and its zone sub-device — and return True.
    Otherwise return False (the caller builds the single entity itself)."""
    if not config.get(CONF_ZONED):
        return False
    zones = hub_zone_numbers(config[CONF_INFINITESP_ID])
    _LOGGER.info(
        "infinitesp: '%s' zoned:yes -> %d entities (zones %s)",
        config.get(CONF_TYPE, config[CONF_ID].id), len(zones), zones,
    )
    for num in zones:
        zc = dict(config)
        zc.pop(CONF_ZONED, None)
        zc[_CONF_ZONE] = num
        zc[CONF_ID] = core.ID(f"{config[CONF_ID].id}_zone{num}", is_declaration=True, type=cls)
        dev = zone_device_id(config[CONF_INFINITESP_ID], num)
        if dev is not None:
            zc[CONF_DEVICE_ID] = dev
        await build_one(zc)
    return True


def zone_entity_raw(hub_id, num, tag, cls, base=None):
    """Build a RAW (unvalidated) per-zone entity config for a platform — the
    single fan-out primitive shared by `auto_zone_entities` and `zoned: yes`.
    Produces a declared, zone-unique ID plus the hub ref and `zone:` so the
    platform's own CONFIG_SCHEMA (which the caller applies) generates the
    name/object_id/device_class and attaches it to the zone sub-device exactly
    like a hand-written `zone: N` entry.

    hub_id: the hub's core.ID (config[CONF_ID]); num: zone number; tag: object-id
    suffix for the declared ID (usually the entity `type`, else the platform name
    for climate/cover); cls: the entity C++ class; base: the entity's own fields
    (e.g. {CONF_TYPE: "temperature", "icon": "..."}).
    """
    hub_key = hub_id.id if hasattr(hub_id, "id") else str(hub_id)
    raw = {
        CONF_ID: core.ID(f"{hub_key}_zone{num}_{tag}", is_declaration=True, type=cls),
        CONF_INFINITESP_ID: hub_id,
        "zone": num,  # platforms' CONF_ZONE; drives set_zone() + sub-device attach
    }
    if base:
        raw.update(base)
    return raw


# Words that should stay upper-cased (or specially-cased) in an auto-generated
# entity name. Keeps friendly names readable when they are derived from a `type`
# token instead of an explicit `name:` (e.g. blower_rpm -> "Blower RPM").
_NAME_ACRONYMS = {
    "odu": "ODU", "idu": "IDU", "sam": "SAM", "hpt": "HPT", "lat": "LAT",
    "rpm": "RPM", "cfm": "CFM", "mac": "MAC", "ssid": "SSID", "url": "URL",
    "id": "ID", "wifi": "WiFi",
}


def name_from_type(type_str):
    """Human-friendly entity name from a `type` token. Title-cases each word but
    keeps known acronyms upper-cased. Crucially slug(result) == type_str, so the
    ESPHome object_id derived from this name equals the type (the binding
    contract). Example: "odu_coil_temp" -> "ODU Coil Temp" (object_id
    odu_coil_temp)."""
    return " ".join(
        _NAME_ACRONYMS.get(w, w.capitalize()) for w in str(type_str).split("_") if w
    )

# ZC zone sensor reference configuration
CONF_ZC_ZONE_2 = "zc_zone_2"
CONF_ZC_ZONE_3 = "zc_zone_3"
CONF_ZC_ZONE_4 = "zc_zone_4"
CONF_ZC_ZONE_5 = "zc_zone_5"   # secondary controller (0x61), local zone 1
CONF_ZC_ZONE_6 = "zc_zone_6"   # secondary controller (0x61), local zone 2
CONF_ZC_ZONE_7 = "zc_zone_7"   # secondary controller (0x61), local zone 3
CONF_ZC_ZONE_8 = "zc_zone_8"   # secondary controller (0x61), local zone 4
# ZC thermistor sensor references (register 0302 ids 0x14/0x1C = LAT/HPT)
CONF_ZC_LAT = "zc_lat"
CONF_ZC_HPT = "zc_hpt"
CONF_TEMPERATURE_SENSOR = "temperature_sensor"
CONF_STALENESS_TIMEOUT = "staleness_timeout"
CONF_SENSOR_UNIT = "sensor_unit"

ZC_ZONE_SCHEMA = cv.Schema({
    cv.Optional(CONF_TEMPERATURE_SENSOR): cv.use_id("sensor"),
    cv.Optional(CONF_STALENESS_TIMEOUT, default=120): cv.positive_int,
    cv.Optional(CONF_SENSOR_UNIT): cv.one_of("C", "F"),
})

TEMP_UNIT_AUTO = "auto"
TEMP_UNIT_FAHRENHEIT = "F"
TEMP_UNIT_CELSIUS = "C"


def _validate_zc_config(config):
    """Warn on ZC sensor misconfiguration."""
    # Zone refs fall back to zone-1 ambient when stale; thermistor refs (LAT/HPT)
    # revert to not-installed. Either way a missing sensor_unit risks a wrong
    # conversion, so warn for all of them.
    sensor_keys = [CONF_ZC_ZONE_2, CONF_ZC_ZONE_3, CONF_ZC_ZONE_4,
                  CONF_ZC_ZONE_5, CONF_ZC_ZONE_6, CONF_ZC_ZONE_7, CONF_ZC_ZONE_8,
                  CONF_ZC_LAT, CONF_ZC_HPT]
    for key in sensor_keys:
        if key not in config:
            continue
        if config.get(CONF_ZONE_CONTROLLER_ADDRESS, 0) == 0:
            _LOGGER.warning("'%s' configured but zone_controller_address is 0; ZC emulation disabled", key)
        # A sensor's native unit is independent of the bus; defaulting to the
        # system unit is a guess. It's caught at runtime by the plausibility
        # check (40-99°F band for zones, -40-250°F for LAT/HPT), but warn so
        # users set sensor_unit explicitly and avoid mis-conversion in the first
        # place.
        if CONF_TEMPERATURE_SENSOR in config[key] and CONF_SENSOR_UNIT not in config[key]:
            _LOGGER.warning(
                "'%s.temperature_sensor' has no 'sensor_unit'; defaulting to the system "
                "unit. A wrong guess is rejected at runtime (falls back to zone-1 ambient "
                "for zones, or not-installed for LAT/HPT), but set 'sensor_unit: F' or "
                "'sensor_unit: C' explicitly to avoid mis-conversion. Check the sensor's "
                "published value to pick correctly.",
                key)
    return config


def _validate_addresses(config):
    """Handle address → sam_address deprecation and mutual exclusion."""
    if CONF_ADDRESS in config:
        if CONF_SAM_ADDRESS in config:
            raise cv.Invalid("Specify 'sam_address' or 'address', not both")
        _LOGGER.warning("'address' is deprecated, use 'sam_address' instead")
        config[CONF_SAM_ADDRESS] = config.pop(CONF_ADDRESS)
    config.setdefault(CONF_SAM_ADDRESS, 0x92)
    return config


def _validate_status_led(config):
    """Ensure status_light_id and status_led_pin are mutually exclusive."""
    if CONF_STATUS_LIGHT_ID in config and CONF_STATUS_LED_PIN in config:
        raise cv.Invalid("status_light_id and status_led_pin are mutually exclusive")
    return config


def _register_zones(config):
    """Record declared zones and create declared device IDs so entity platforms
    can auto-attach. The IDs are stored in config (under CONF_ZONES as {num:
    (name, ID)}) so the ID-collection pass (iter_ids) registers them as declared
    — making them resolvable by entities' device_id references."""
    if CONF_ZONES in config:
        hub_key = str(config[CONF_ID])
        registry = {}
        new_zones = {}
        for num, zname in config[CONF_ZONES].items():
            dev_id = core.ID(f"{hub_key}_zone{num}_dev", is_declaration=True, type=Device)
            new_zones[num] = {"name": zname, "id": dev_id}
            registry[num] = zname
        config[CONF_ZONES] = new_zones  # {num: {name, id}} — ID now walkable by iter_ids
        _HUB_ZONES[hub_key] = registry
    return config


# Key under which the synthesized fault-history sub-device + entity configs are
# stashed in the hub config (so iter_ids walks the declared IDs and to_code can
# codegen them). Not a user-facing option.
_KEY_FAULT = "_fault_history_gen"


def _register_fault_history(config):
    """When `fault_history: true`, synthesize a "Fault History" HA sub-device and
    the full set of fault text sensors (fault_1..10 + fault_history) attached to
    it — no YAML entries required. Each entity config is validated through the
    text_sensor platform's own CONFIG_SCHEMA here (validation phase) so names,
    object_ids and IDs are generated exactly as a hand-written entry would be;
    to_code then just codegens them. Mirrors how zones declare sub-device IDs."""
    if not config.get(CONF_FAULT_HISTORY):
        return config
    # Lazy import: the text_sensor platform module imports from this package, so a
    # top-level import here would be circular. By now this module is fully loaded.
    from .text_sensor import CONFIG_SCHEMA as TS_SCHEMA, InfinitESPTextSensor

    hub_key = str(config[CONF_ID])
    dev_name = f"{hub_key}_fault_dev"
    dev_decl = core.ID(dev_name, is_declaration=True, type=Device)
    entities = []
    for t in _FAULT_TYPES:
        raw = {
            CONF_ID: core.ID(f"{hub_key}_{t}", is_declaration=True, type=InfinitESPTextSensor),
            CONF_INFINITESP_ID: config[CONF_ID],
            CONF_TYPE: t,
            CONF_DEVICE_ID: dev_name,  # reference -> the fault sub-device (resolved in to_code)
            CONF_ENTITY_CATEGORY: "diagnostic",
            CONF_ICON: "mdi:alert-circle-outline",
        }
        entities.append(TS_SCHEMA(raw))
    config[_KEY_FAULT] = {"name": "Fault History", "dev_id": dev_decl, "entities": entities}
    return config


# Key under which synthesized per-zone entity configs are stashed in the hub
# config. Not a user-facing option.
_KEY_ZONE_ENTS = "_zone_entities_gen"


def _zone_platforms():
    """Lazy-import the zone entity platforms (their modules import from this
    package, so a top-level import would be circular). Returns
    {name: (CONFIG_SCHEMA, to_code, entity_class)}."""
    from . import climate as _cl, cover as _co, sensor as _se
    from . import number as _nu, select as _sl, binary_sensor as _bs, text_sensor as _ts
    return {
        "climate": (_cl.CONFIG_SCHEMA, _cl.to_code, _cl.InfinitESPClimate),
        "cover": (_co.CONFIG_SCHEMA, _co.to_code, _co.InfinitESPCover),
        "sensor": (_se.CONFIG_SCHEMA, _se.to_code, _se.InfinitESPSensor),
        "number": (_nu.CONFIG_SCHEMA, _nu.to_code, _nu.InfinitESPNumber),
        "select": (_sl.CONFIG_SCHEMA, _sl.to_code, _sl.InfinitESPSelect),
        "binary_sensor": (_bs.CONFIG_SCHEMA, _bs.to_code, _bs.InfinitESPBinarySensor),
        "text_sensor": (_ts.CONFIG_SCHEMA, _ts.to_code, _ts.InfinitESPTextSensor),
    }


def _register_zone_entities(config):
    """When `auto_zone_entities: true`, create every per-zone entity type (see
    _auto_zone_specs — derived from the "zoned" type flags) for every declared
    zone, minus any listed in `exclude_zone_entities`. No per-zone YAML blocks
    needed. Each entity config is validated through its platform's own
    CONFIG_SCHEMA here (so name/object_id/ID/device_class and the zone sub-device
    attachment are produced exactly as a hand-written entry would be); to_code
    codegens them. Runs after _register_zones so the zone sub-device IDs are
    declared. Works for all platforms because the climate/cover/number entity C++
    classes live in the always-compiled base component dir."""
    if not config.get(CONF_AUTO_ZONE_ENTITIES) or CONF_ZONES not in config:
        return config
    specs = _auto_zone_specs()
    valid_keys = {etype or pname for pname, etype in specs}
    exclude = set(config.get(CONF_EXCLUDE_ZONE_ENTITIES, []))
    unknown = exclude - valid_keys
    if unknown:
        raise cv.Invalid(
            f"exclude_zone_entities has unknown entr{'y' if len(unknown) == 1 else 'ies'} "
            f"{sorted(unknown)}; valid: {sorted(valid_keys)}"
        )
    platforms = _zone_platforms()
    generated = []  # (platform_name, validated_config)
    for num in config[CONF_ZONES]:
        for pname, etype in specs:
            tag = etype or pname  # object-id suffix + exclude key
            if tag in exclude:
                continue
            schema, _tc, cls = platforms[pname]
            base = dict(_ZONE_AUTO_EXTRAS.get(tag, {}))
            if etype is not None:
                base[CONF_TYPE] = etype
            raw = zone_entity_raw(config[CONF_ID], num, tag, cls, base)
            generated.append((pname, schema(raw)))
    config[_KEY_ZONE_ENTS] = generated
    return config


CONFIG_SCHEMA = cv.All(
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(InfinitESPComponent),
            cv.Optional(CONF_ADDRESS): cv.int_range(min=0, max=255),
            cv.Optional(CONF_SAM_ADDRESS): cv.int_range(min=0, max=255),
            # Status LED: reference an existing light entity (e.g. WS2812 RGB)
            cv.Optional(CONF_STATUS_LIGHT_ID): cv.use_id("light"),
            # Status LED: shorthand for a simple LED on a GPIO pin
            cv.Optional(CONF_STATUS_LED_PIN): pins.gpio_output_pin_schema,
            # RS485 transmit enable pin (DE/RE control)
            cv.Optional(CONF_FLOW_CONTROL_PIN): pins.gpio_output_pin_schema,
            # Optional time source (e.g. homeassistant_time) for fault-history dates
            cv.Optional(CONF_TIME_ID): cv.use_id(time_.RealTimeClock),
            # Zone controller emulation: set to 0x60 to emulate a SYSTXCC4ZC01
            cv.Optional(CONF_ZONE_CONTROLLER_ADDRESS, default=0): cv.int_range(min=0, max=255),
            # Temperature unit: auto (heuristic), F, or C
            cv.Optional(CONF_TEMPERATURE_UNIT, default=TEMP_UNIT_AUTO): cv.one_of(TEMP_UNIT_AUTO, TEMP_UNIT_FAHRENHEIT, TEMP_UNIT_CELSIUS),
            # ZC zone temperature sensor references (requires zone_controller_address).
            # Zones 2-4 are on the primary controller (0x60); 5-8 on a second
            # controller at +1 (0x61). Zone 1 is always thermostat-direct.
            cv.Optional(CONF_ZC_ZONE_2): ZC_ZONE_SCHEMA,
            cv.Optional(CONF_ZC_ZONE_3): ZC_ZONE_SCHEMA,
            cv.Optional(CONF_ZC_ZONE_4): ZC_ZONE_SCHEMA,
            cv.Optional(CONF_ZC_ZONE_5): ZC_ZONE_SCHEMA,
            cv.Optional(CONF_ZC_ZONE_6): ZC_ZONE_SCHEMA,
            cv.Optional(CONF_ZC_ZONE_7): ZC_ZONE_SCHEMA,
            cv.Optional(CONF_ZC_ZONE_8): ZC_ZONE_SCHEMA,
            # ZC thermistor references (LAT/HPT). Same schema; when the fed
            # sensor goes stale the entry reverts to not-installed (no ambient
            # fallback, unlike zones).
            cv.Optional(CONF_ZC_LAT): ZC_ZONE_SCHEMA,
            cv.Optional(CONF_ZC_HPT): ZC_ZONE_SCHEMA,
            # Per-zone HA sub-devices: {zone_number: "Display Name"}. Entities
            # with a matching `zone:` auto-group under these in Home Assistant.
            cv.Optional(CONF_ZONES): cv.Schema({cv.int_range(min=1, max=8): cv.string}),
            # Auto-create a "Fault History" sub-device with fault_1..10 +
            # fault_history text sensors (no YAML entries needed).
            cv.Optional(CONF_FAULT_HISTORY, default=False): cv.boolean,
            # Auto-create every per-zone entity type for each declared zone,
            # derived from the platforms' "zoned" type flags (climate, damper
            # cover, temp/humidity/damper_position + zc_zone_temperature sensors,
            # heat/cool_target numbers, fan_mode/activity/hold_mode selects,
            # occupancy, hold_state/zone_name) — no per-zone YAML blocks needed.
            cv.Optional(CONF_AUTO_ZONE_ENTITIES, default=False): cv.boolean,
            # Zone entity types to skip when auto_zone_entities is on. Values are
            # type names (e.g. zc_zone_temperature) or "climate"/"cover".
            cv.Optional(CONF_EXCLUDE_ZONE_ENTITIES, default=list): cv.ensure_list(cv.string),
        }
    ).extend(cv.COMPONENT_SCHEMA).extend(uart.UART_DEVICE_SCHEMA),
    _validate_addresses,
    _validate_status_led,
    _validate_zc_config,
    _register_zones,
    _register_fault_history,
    _register_zone_entities,
)

INFINITESP_DEVICE_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(InfinitESPComponent),
    }
)


async def register_infinitesp_entity(var, config):
    parent = await cg.get_variable(config[CONF_INFINITESP_ID])
    cg.add(parent.register_entity(var))
    cg.add(var.set_parent(parent))


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    cg.add(var.set_sam_address(config[CONF_SAM_ADDRESS]))

    # HA sub-devices: per-zone (`zones:`) and, if enabled, a "Fault History"
    # device. Each has a declared ID (stored in config so iter_ids registered it);
    # entities attach via device_id. ESPHOME_DEVICE_COUNT must cover them all.
    sub_devices = []  # (declared_id, name)
    if CONF_ZONES in config:
        for num, z in config[CONF_ZONES].items():
            sub_devices.append((z["id"], z["name"]))
    if _KEY_FAULT in config:
        fh = config[_KEY_FAULT]
        sub_devices.append((fh["dev_id"], fh["name"]))

    if sub_devices:
        cg.add_define("USE_DEVICES")
        cg.add_define("ESPHOME_DEVICE_COUNT", len(sub_devices))
        for decl_id, name in sub_devices:
            dev = cg.new_Pvariable(decl_id)
            cg.add(dev.set_device_id(fnv1a_32bit_hash(decl_id.id)))
            cg.add(dev.set_name(name))
            cg.add(cg.App.register_device(dev))

    # Codegen the auto-generated fault text sensors (validated in
    # _register_fault_history) now that their sub-device exists.
    if _KEY_FAULT in config:
        from .text_sensor import to_code as ts_to_code
        for ent_conf in config[_KEY_FAULT]["entities"]:
            await ts_to_code(ent_conf)

    # Codegen the auto-generated per-zone entities (validated in
    # _register_zone_entities) now that the zone sub-devices exist. The
    # climate/cover/number classes live in the base component dir, so their
    # sources/headers are always present — no platform section required.
    if _KEY_ZONE_ENTS in config:
        platforms = _zone_platforms()
        for pname, ent_conf in config[_KEY_ZONE_ENTS]:
            await platforms[pname][1](ent_conf)  # platform to_code

    if config[CONF_ZONE_CONTROLLER_ADDRESS] != 0:
        cg.add(var.set_zc_address(config[CONF_ZONE_CONTROLLER_ADDRESS]))

    # Wire up ZC zone temperature sensor references. Zones 2-4 → primary
    # controller (0x60); 5-8 → secondary controller (0x61).
    for zone_num, zone_key in [(2, CONF_ZC_ZONE_2), (3, CONF_ZC_ZONE_3), (4, CONF_ZC_ZONE_4),
                               (5, CONF_ZC_ZONE_5), (6, CONF_ZC_ZONE_6),
                               (7, CONF_ZC_ZONE_7), (8, CONF_ZC_ZONE_8)]:
        if zone_key in config:
            zone_cfg = config[zone_key]
            if CONF_TEMPERATURE_SENSOR in zone_cfg:
                sens = await cg.get_variable(zone_cfg[CONF_TEMPERATURE_SENSOR])
                cg.add(var.set_zc_temperature_sensor(zone_num, sens))
                # Explicit sensor_unit overrides the default (inherit from bus)
                if CONF_SENSOR_UNIT in zone_cfg:
                    is_f = zone_cfg[CONF_SENSOR_UNIT] == "F"
                    cg.add(var.set_zc_sensor_is_fahrenheit(zone_num, is_f))
            timeout = zone_cfg.get(CONF_STALENESS_TIMEOUT, 120)
            cg.add(var.set_zc_staleness_timeout(zone_num, timeout * 1000))

    # Wire up ZC thermistor references (LAT/HPT) — feeds external ESPHome
    # sensors into register 0302 ids 0x14/0x1C. Emulation only.
    for key, set_sensor, set_unit, set_stale in [
        (CONF_ZC_LAT, var.set_zc_lat_sensor, var.set_zc_lat_is_fahrenheit, var.set_zc_lat_staleness),
        (CONF_ZC_HPT, var.set_zc_hpt_sensor, var.set_zc_hpt_is_fahrenheit, var.set_zc_hpt_staleness),
    ]:
        if key not in config:
            continue
        tcfg = config[key]
        if CONF_TEMPERATURE_SENSOR in tcfg:
            sens = await cg.get_variable(tcfg[CONF_TEMPERATURE_SENSOR])
            cg.add(set_sensor(sens))
            if CONF_SENSOR_UNIT in tcfg:
                cg.add(set_unit(tcfg[CONF_SENSOR_UNIT] == "F"))
        cg.add(set_stale(tcfg.get(CONF_STALENESS_TIMEOUT, 120) * 1000))

    temp_unit = config[CONF_TEMPERATURE_UNIT]
    if temp_unit == TEMP_UNIT_AUTO:
        cg.add(var.set_temperature_unit(cg.RawExpression("TemperatureUnit::AUTO")))
    elif temp_unit == TEMP_UNIT_FAHRENHEIT:
        cg.add(var.set_temperature_unit(cg.RawExpression("TemperatureUnit::FAHRENHEIT")))
    elif temp_unit == TEMP_UNIT_CELSIUS:
        cg.add(var.set_temperature_unit(cg.RawExpression("TemperatureUnit::CELSIUS")))

    if CONF_STATUS_LED_PIN in config:
        pin = await cg.gpio_pin_expression(config[CONF_STATUS_LED_PIN])
        cg.add(var.set_status_led_pin(pin))
        cg.add_define("USE_INFINITESP_STATUS_LED_PIN")

    if CONF_FLOW_CONTROL_PIN in config:
        pin = await cg.gpio_pin_expression(config[CONF_FLOW_CONTROL_PIN])
        cg.add(var.set_flow_control_pin(pin))
        cg.add_define("USE_INFINITESP_FLOW_CONTROL_PIN")

    if CONF_TIME_ID in config:
        rtc = await cg.get_variable(config[CONF_TIME_ID])
        cg.add(var.set_time(rtc))

    if CONF_STATUS_LIGHT_ID in config:
        light_var = await cg.get_variable(config[CONF_STATUS_LIGHT_ID])
        cg.add(var.set_status_light(light_var))
        cg.add_define("USE_INFINITESP_STATUS_LIGHT")

    await cg.register_component(var, config)
    await uart.register_uart_device(var, config)
