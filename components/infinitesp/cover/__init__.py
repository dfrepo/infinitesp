import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import automation
from esphome.components import cover
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

# Zone damper cover. Reports damper position from the bus (register 0308,
# mirrored to 0319). device_class is set via YAML (use device_class: damper).
#
# Optional on_change fires whenever the cover's reported position doesn't match
# the commanded position — whether the command came from the thermostat (bus)
# or from Home Assistant — passing the new 0.0-1.0 position as `pos`. The cover
# never writes the ABCD bus; what the action does (log, drive relays, toggle
# GPIO) is up to the user. An un-attached trigger is a no-op, so omitting
# on_change keeps the cover as a pure position reporter.

InfinitESPCover = infinitesp_ns.class_("InfinitESPCover", cover.Cover, InfinitESPEntity)

CONF_ZONE = "zone"
CONF_ON_CHANGE = "on_change"


def _default_name(config):
    """A cover has no `type:` field — its identity IS the component type. Default
    the name to "Cover" when omitted so object_id == "cover" (cover.<zone>_cover)."""
    if CONF_NAME not in config:
        config[CONF_NAME] = "Cover"
    return config


def _inject_device_id(config):
    """Attach the zone damper to its HA sub-device BEFORE the base schema's
    duplicate-name validator runs, so every zone can share the name "Cover"."""
    if CONF_ZONE in config:
        dev_id = zone_device_id(config.get(CONF_INFINITESP_ID), config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    return config


CONFIG_SCHEMA = cv.All(
    lambda c: check_zone_binding(c, True, "cover"),  # always per-zone
    _default_name,
    _inject_device_id,
    cover.cover_schema(InfinitESPCover).extend(
        {
            cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(CONF_INFINITESP_ID),
            cv.Optional(CONF_ZONE): cv.int_range(min=1, max=8),
            cv.Optional(CONF_ZONED): cv.boolean,
            cv.Optional(CONF_ON_CHANGE): automation.validate_automation(single=True),
        }
    ),
)

async def to_code(config):
    async def build(c):
        var = cg.new_Pvariable(c[CONF_ID])
        await cover.register_cover(var, c)
        cg.add(var.set_zone(c.get(CONF_ZONE, 1)))
        cg.add(var.set_bus_class(6))  # 0x60 >> 4
        if CONF_ON_CHANGE in c:
            await automation.build_automation(
                var.get_change_trigger(), [(float, "pos")], c[CONF_ON_CHANGE]
            )
        await register_infinitesp_entity(var, c)

    if await codegen_zoned(config, InfinitESPCover, build):
        return
    dev = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
    if dev is not None:
        config[CONF_DEVICE_ID] = dev
    await build(config)
