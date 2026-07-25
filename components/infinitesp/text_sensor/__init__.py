import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import text_sensor
from esphome.const import CONF_ID, CONF_TYPE, CONF_DEVICE_ID
from .. import (
    InfinitESPEntity,
    CONF_INFINITESP_ID,
    infinitesp_ns,
    register_infinitesp_entity,
    zone_device_id,
)

CONF_ZONE = "zone"
CONF_DEVICE_ADDRESS = "device_address"

InfinitESPTextSensor = infinitesp_ns.class_("InfinitESPTextSensor", text_sensor.TextSensor, InfinitESPEntity)

# Per-zone text_sensor types auto-attach to their zone HA sub-device; global
# types (tstat_*, fault_*, device_model, ...) stay on the main node.
TEXT_SENSOR_ZONED = {"zone_name", "hold_state", "comfort_profile"}

TEXT_SENSOR_TYPES = {
    "zone_name": "zone_name",
    "hold_state": "hold_state",
    "tstat_ssid": "tstat_ssid",
    "tstat_hostname": "tstat_hostname",
    "tstat_wifi_mac": "tstat_wifi_mac",
    "tstat_cloud_host": "tstat_cloud_host",
    "tstat_proxy_server": "tstat_proxy_server",
    "tstat_dealer_name": "tstat_dealer_name",
    "tstat_dealer_brand": "tstat_dealer_brand",
    "tstat_dealer_url": "tstat_dealer_url",
    "comfort_profile": "comfort_profile",
    "fault_history": "fault_history",
    "manufacture_date": "manufacture_date",
    "device_model": "device_model",
    # Per-entry fault sensors (1 = most recent) for a Markdown card that needs
    # no 255-char limit. Enable in YAML as needed.
    **{f"fault_{i}": f"fault_{i}" for i in range(1, 11)},
}

def _inject_device_id(config):
    """Pre-schema: attach per-zone text sensors to their zone HA sub-device before
    the base schema's duplicate-name validator runs."""
    if config.get(CONF_TYPE) in TEXT_SENSOR_ZONED and CONF_ZONE in config:
        dev_id = zone_device_id(config.get(CONF_INFINITESP_ID), config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    return config


CONFIG_SCHEMA = cv.All(
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
    var = cg.new_Pvariable(config[CONF_ID])
    await text_sensor.register_text_sensor(var, config)
    cg.add(var.set_zone(config[CONF_ZONE]))
    cg.add(var.set_sensor_type(TEXT_SENSOR_TYPES[config[CONF_TYPE]]))
    if CONF_DEVICE_ADDRESS in config:
        cg.add(var.set_device_address(config[CONF_DEVICE_ADDRESS]))
    await register_infinitesp_entity(var, config)
