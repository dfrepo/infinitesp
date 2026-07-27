import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import number
from esphome.const import CONF_ID, CONF_NAME, CONF_TYPE, CONF_DEVICE_ID, DEVICE_CLASS_TEMPERATURE
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

InfinitESPNumber = infinitesp_ns.class_("InfinitESPNumber", number.Number, InfinitESPEntity)

# The ABCD bus works in whole °F; Home Assistant treats ESPHome temperatures as
# °C internally and converts for display. Match the climate entity's range
# (40–99 °F) so the number and the climate slider agree. step=1.0 for the same
# reason as the climate entity: HA rounds the raw °C step to 1 decimal, so a
# true 1°F step (5/9 °C) would render as 0.6; 1.0 shows cleanly and control()
# snaps to the nearest whole °F on write regardless.
STEP_C = 5.0 / 9.0
MIN_C = (40.0 - 32.0) * STEP_C
MAX_C = (99.0 - 32.0) * STEP_C

# type -> {zoned, label}. The `type` is the stable CONTRACT: it drives both the
# firmware behavior (which 3B03 setpoint byte) AND the entity's object_id. When
# the user omits `name`, we default it from `label` so the object_id is always
# the type slug (e.g. `heat_target`) — letting the card bind by type regardless
# of the display name (which the user can freely change in Home Assistant).
NUMBER_TYPES = {
    "heat_target": {"zoned": True, "label": "Heat Target"},
    "cool_target": {"zoned": True, "label": "Cool Target"},
}


def _validate_zone(config):
    """Strict: per-zone types need `zone: N` xor `zoned: yes`; global forbids both."""
    return check_zone_binding(
        config, NUMBER_TYPES[config[CONF_TYPE]]["zoned"], f"number type '{config[CONF_TYPE]}'"
    )


def _default_name_from_type(config):
    """Default the entity name from its type so object_id == type (the contract).
    Runs pre-schema. If the user omits `name`, we set it to the type's label
    (e.g. 'Heat Target' -> object_id 'heat_target'); the card binds by that type
    slug. Users who want a different display name can rename it in Home Assistant
    without changing the object_id/entity_id."""
    info = NUMBER_TYPES.get(config.get(CONF_TYPE, ""))
    if info and CONF_NAME not in config:
        config[CONF_NAME] = info["label"]
    return config


def _inject_device_id(config):
    """Auto-attach zoned entities to their hub zone sub-device BEFORE the base
    schema's duplicate-name validator runs, so two zones can each have e.g. a
    'Heat Target'. Runs first in cv.All (pre-schema). The device_id string is
    resolved by the base schema's sub_device_id validator against the declared
    ID the hub stored in its config (see _register_zones)."""
    if NUMBER_TYPES.get(config.get(CONF_TYPE, ""), {}).get("zoned") and CONF_ZONE in config:
        hub_id = config.get(CONF_INFINITESP_ID)
        dev_id = zone_device_id(hub_id, config[CONF_ZONE]) if hub_id is not None else None
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    return config


CONFIG_SCHEMA = cv.All(
    _default_name_from_type,
    _validate_zone,
    _inject_device_id,
    number.number_schema(
        InfinitESPNumber,
        unit_of_measurement="°C",
        device_class=DEVICE_CLASS_TEMPERATURE,
    ).extend(
        {
            cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(CONF_INFINITESP_ID),
            cv.Required(CONF_TYPE): cv.one_of(*NUMBER_TYPES, lower=True),
            # No default: presence is meaningful — _validate_zone requires a
            # binding (zone: or zoned:) for per-zone types, forbids it for global.
            cv.Optional(CONF_ZONE): cv.int_range(min=1, max=8),
            cv.Optional(CONF_ZONED): cv.boolean,
        }
    ),
)


async def to_code(config):
    zoned = NUMBER_TYPES[config[CONF_TYPE]]["zoned"]

    async def build(c):
        var = cg.new_Pvariable(c[CONF_ID])
        await number.register_number(var, c, min_value=MIN_C, max_value=MAX_C, step=1.0)
        if zoned:
            cg.add(var.set_zone(c.get(CONF_ZONE, 1)))
        cg.add(var.set_number_type(c[CONF_TYPE]))
        await register_infinitesp_entity(var, c)

    if await codegen_zoned(config, InfinitESPNumber, build):
        return
    if zoned and CONF_ZONE in config:
        dev = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
        if dev is not None:
            config[CONF_DEVICE_ID] = dev
    await build(config)
