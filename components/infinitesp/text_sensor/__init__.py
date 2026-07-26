import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import text_sensor
from esphome.const import CONF_ID, CONF_NAME, CONF_TYPE, CONF_DEVICE_ID
from .. import (
    InfinitESPEntity,
    CONF_INFINITESP_ID,
    infinitesp_ns,
    register_infinitesp_entity,
    zone_device_id,
    name_from_type,
)

CONF_ZONE = "zone"
CONF_DEVICE_ADDRESS = "device_address"

InfinitESPTextSensor = infinitesp_ns.class_("InfinitESPTextSensor", text_sensor.TextSensor, InfinitESPEntity)

# Per-zone text_sensor types auto-attach to their zone HA sub-device; global
# types stay on the main node.
# Per-zone text_sensor types auto-attach to their zone HA sub-device; global
# types stay on the main node. NOTE: comfort_profile is intentionally NOT zoned —
# its decode reads a single fixed register (0x400A, zone 1's comfort table), so
# it's effectively a global/system diagnostic, not per-zone data.
TEXT_SENSOR_ZONED = {"zone_name", "hold_state"}

# type -> {key, [address]}. The dict KEY is the user-facing `type` (== object_id);
# `key` is the internal firmware sensor-type (decode path), decoupled so a type
# can be renamed to a self-describing token without touching firmware behavior
# (e.g. type "dealer_name" -> internal key "tstat_dealer_name"). `address` is a
# default bus device address baked into role types so it need not be set in YAML
# (e.g. the three model sensors read the same "device_model" from ODU/IDU/ZC).
TEXT_SENSOR_TYPES = {
    "zone_name": {"key": "zone_name"},
    "hold_state": {"key": "hold_state"},
    "comfort_profile": {"key": "comfort_profile"},
    "thermostat_wifi_ssid": {"key": "tstat_ssid"},
    "thermostat_hostname": {"key": "tstat_hostname"},
    "thermostat_wifi_mac": {"key": "tstat_wifi_mac"},
    "thermostat_cloud_host": {"key": "tstat_cloud_host"},
    "thermostat_proxy_server": {"key": "tstat_proxy_server"},
    "dealer_name": {"key": "tstat_dealer_name"},
    "dealer_brand": {"key": "tstat_dealer_brand"},
    "dealer_url": {"key": "tstat_dealer_url"},
    "fault_history": {"key": "fault_history"},
    "manufacture_date": {"key": "manufacture_date"},
    # Model readers: same internal "device_model" decode, distinguished by the
    # bus device address. Role types bake in the standard default address (still
    # overridable via `device_address:`), giving each a unique object_id.
    "device_model": {"key": "device_model"},               # generic (set device_address:)
    "outdoor_unit_model": {"key": "device_model", "address": 0x50},
    "furnace_model": {"key": "device_model", "address": 0x40},
    "zoning_board_model": {"key": "device_model", "address": 0x60},
    # Per-entry fault sensors (1 = most recent) for a Markdown card that needs
    # no 255-char limit. Enable in YAML as needed.
    **{f"fault_{i}": {"key": f"fault_{i}"} for i in range(1, 11)},
}


def _default_name(config):
    """Default the entity name from its `type` when omitted (object_id == type),
    acronym-aware. Explicit `name:` still wins."""
    if CONF_NAME not in config and CONF_TYPE in config:
        config[CONF_NAME] = name_from_type(config[CONF_TYPE])
    return config


def _inject_device_id(config):
    """Pre-schema: attach per-zone text sensors to their zone HA sub-device before
    the base schema's duplicate-name validator runs."""
    if config.get(CONF_TYPE) in TEXT_SENSOR_ZONED and CONF_ZONE in config:
        dev_id = zone_device_id(config.get(CONF_INFINITESP_ID), config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    return config


CONFIG_SCHEMA = cv.All(
    _default_name,
    _inject_device_id,
    text_sensor.text_sensor_schema(InfinitESPTextSensor).extend(
        {
            cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(CONF_INFINITESP_ID),
            cv.Required(CONF_TYPE): cv.one_of(*TEXT_SENSOR_TYPES, lower=True),
            cv.Optional(CONF_ZONE, default=1): cv.int_range(min=1, max=8),
            cv.Optional(CONF_DEVICE_ADDRESS): cv.hex_uint8_t,
        }
    ),
)


async def to_code(config):
    if config[CONF_TYPE] in TEXT_SENSOR_ZONED:
        dev_id = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    info = TEXT_SENSOR_TYPES[config[CONF_TYPE]]
    var = cg.new_Pvariable(config[CONF_ID])
    await text_sensor.register_text_sensor(var, config)
    cg.add(var.set_zone(config[CONF_ZONE]))
    cg.add(var.set_sensor_type(info["key"]))
    # Device address: explicit YAML wins, else the role type's baked-in default.
    addr = config.get(CONF_DEVICE_ADDRESS, info.get("address"))
    if addr is not None:
        cg.add(var.set_device_address(addr))
    await register_infinitesp_entity(var, config)
