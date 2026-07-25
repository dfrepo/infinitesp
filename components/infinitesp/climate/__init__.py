import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import climate
from esphome.const import CONF_ID, CONF_DEVICE_ID
from .. import (
    InfinitESPEntity,
    CONF_INFINITESP_ID,
    infinitesp_ns,
    register_infinitesp_entity,
    zone_device_id,
)

CONF_ZONE = "zone"

InfinitESPClimate = infinitesp_ns.class_("InfinitESPClimate", climate.Climate, InfinitESPEntity)


def _inject_device_id(config):
    """Attach the zone climate to its HA sub-device BEFORE the base schema's
    duplicate-name validator runs, so every zone can share the name "Climate".
    Resolves against the declared zone-device ID the hub stored in its config."""
    if CONF_ZONE in config:
        dev_id = zone_device_id(config.get(CONF_INFINITESP_ID), config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    return config


CONFIG_SCHEMA = cv.All(
    _inject_device_id,
    climate.climate_schema(InfinitESPClimate).extend(
        {
            cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(CONF_INFINITESP_ID),
            cv.Required(CONF_ZONE): cv.int_range(min=1, max=8),
        }
    ),
)


async def to_code(config):
    # Re-assert the sub-device attachment before register_climate (device_id must
    # be set before registration so the entity attaches to the zone sub-device).
    dev_id = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
    if dev_id is not None:
        config[CONF_DEVICE_ID] = dev_id
    var = cg.new_Pvariable(config[CONF_ID])
    await climate.register_climate(var, config)
    cg.add(var.set_zone(config[CONF_ZONE]))
    await register_infinitesp_entity(var, config)
