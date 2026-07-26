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

# The full set of fault-history text sensors auto-created when `fault_history:
# true` is set on the hub. Register 0x4202 always holds exactly 10 entries; the
# combined `fault_history` string plus fault_1..fault_10 mirror the explicit
# per-entry sensors — but generated in code so no YAML boilerplate is needed.
_FAULT_TYPES = [f"fault_{i}" for i in range(1, 11)] + ["fault_history"]

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
        }
    ).extend(cv.COMPONENT_SCHEMA).extend(uart.UART_DEVICE_SCHEMA),
    _validate_addresses,
    _validate_status_led,
    _validate_zc_config,
    _register_zones,
    _register_fault_history,
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
