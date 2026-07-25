import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import binary_sensor
from esphome.const import CONF_ID, CONF_NAME, CONF_TYPE, CONF_DEVICE_CLASS, CONF_DEVICE_ID
from .. import (
    InfinitESPEntity,
    CONF_INFINITESP_ID,
    infinitesp_ns,
    register_infinitesp_entity,
    zone_device_id,
)

CONF_ZONE = "zone"

InfinitESPBinarySensor = infinitesp_ns.class_("InfinitESPBinarySensor", binary_sensor.BinarySensor, InfinitESPEntity)

# Per-zone binary_sensor types auto-attach to their zone HA sub-device; global
# types (bus_status/electric_heat/compressor_running/active_fault) stay on main.
BINARY_SENSOR_ZONED = {"occupancy"}

# value = {"bus_class": <device-class nibble>, "device_class": optional HA default}
BINARY_SENSOR_TYPES = {
    "bus_status": {"bus_class": 0},          # not register-based
    "electric_heat": {"bus_class": 4},       # IDU register
    "compressor_running": {"bus_class": 5},  # ODU register
    # Per-zone: SAM 3B02 offset-21 zones_unoccupied flag (occupied = bit clear).
    # NOTE this is the thermostat's occupied/away schedule state, not motion.
    "occupancy": {"bus_class": 0, "device_class": "occupancy"},
    # System-wide: ON when any thermostat fault-history (0x4202) entry is active.
    "active_fault": {"bus_class": 0, "device_class": "problem"},
}

def _default_name(config):
    """Default the entity name from its `type` when omitted (object_id == type).
    Explicit `name:` still wins (curated global binary sensors keep their labels)."""
    if CONF_NAME not in config and CONF_TYPE in config:
        config[CONF_NAME] = config[CONF_TYPE].replace("_", " ").title()
    return config


def _inject_device_id(config):
    """Pre-schema: attach per-zone binary sensors (occupancy) to their zone HA
    sub-device before the base schema's duplicate-name validator runs."""
    if config.get(CONF_TYPE) in BINARY_SENSOR_ZONED and CONF_ZONE in config:
        dev_id = zone_device_id(config.get(CONF_INFINITESP_ID), config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    return config


CONFIG_SCHEMA = cv.All(
    _default_name,
    _inject_device_id,
    binary_sensor.binary_sensor_schema(InfinitESPBinarySensor).extend(
        {
            cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(CONF_INFINITESP_ID),
            cv.Required(CONF_TYPE): cv.one_of(*BINARY_SENSOR_TYPES, lower=True),
            cv.Optional(CONF_ZONE, default=1): cv.int_range(min=1, max=8),
        }
    ),
)

async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    info = BINARY_SENSOR_TYPES[config[CONF_TYPE]]
    if config[CONF_TYPE] in BINARY_SENSOR_ZONED:
        dev_id = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    cg.add(var.set_sensor_type(config[CONF_TYPE]))
    cg.add(var.set_bus_class(info["bus_class"]))
    cg.add(var.set_zone(config[CONF_ZONE]))
    if info.get("device_class"):
        config[CONF_DEVICE_CLASS] = info["device_class"]
    await binary_sensor.register_binary_sensor(var, config)
    await register_infinitesp_entity(var, config)
