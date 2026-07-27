import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import climate
from esphome.const import CONF_ID, CONF_NAME, CONF_DEVICE_ID
from .. import (
    InfinitESPEntity,
    CONF_INFINITESP_ID,
    CONF_ZONED,
    infinitesp_ns,
    register_infinitesp_entity,
    zone_device_id,
    check_zone_binding,
    codegen_zoned,
)

CONF_ZONE = "zone"

InfinitESPClimate = infinitesp_ns.class_("InfinitESPClimate", climate.Climate, InfinitESPEntity)


def _default_name(config):
    """A climate has no `type:` field — its identity IS the component type. Default
    the name to "Climate" when omitted so object_id == "climate" (climate.<zone>_climate)."""
    if CONF_NAME not in config:
        config[CONF_NAME] = "Climate"
    return config


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
    lambda c: check_zone_binding(c, True, "climate"),  # always per-zone
    _default_name,
    _inject_device_id,
    climate.climate_schema(InfinitESPClimate).extend(
        {
            cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(CONF_INFINITESP_ID),
            cv.Optional(CONF_ZONE): cv.int_range(min=1, max=8),
            cv.Optional(CONF_ZONED): cv.boolean,
        }
    ),
)


async def to_code(config):
    async def build(c):
        var = cg.new_Pvariable(c[CONF_ID])
        await climate.register_climate(var, c)
        cg.add(var.set_zone(c.get(CONF_ZONE, 1)))
        await register_infinitesp_entity(var, c)

    if await codegen_zoned(config, InfinitESPClimate, build):
        return
    dev = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
    if dev is not None:
        config[CONF_DEVICE_ID] = dev
    await build(config)
