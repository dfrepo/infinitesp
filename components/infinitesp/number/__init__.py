import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import number
from esphome.const import CONF_ID, CONF_NAME, CONF_TYPE, CONF_DEVICE_ID, DEVICE_CLASS_TEMPERATURE
from .. import (
    InfinitESPEntity,
    CONF_INFINITESP_ID,
    infinitesp_ns,
    register_infinitesp_entity,
    zone_device_id,
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
    """Enforce zone: presence per type (per-zone types require it; global forbid it)."""
    zoned = NUMBER_TYPES[config[CONF_TYPE]]["zoned"]
    has_zone = CONF_ZONE in config
    if zoned and not has_zone:
        raise cv.Invalid(f"number type '{config[CONF_TYPE]}' is per-zone; add 'zone:'")
    if not zoned and has_zone:
        raise cv.Invalid(f"number type '{config[CONF_TYPE]}' is global; remove 'zone:'")
    return config


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
            # No default: presence is meaningful — _validate_zone requires it for
            # per-zone types and forbids it for global ones.
            cv.Optional(CONF_ZONE): cv.int_range(min=1, max=8),
        }
    ),
)


async def to_code(config):
    # Attach to the zone sub-device via config so the standard registration
    # both wires the device AND applies per-device name uniqueness (two zones
    # can each have a "Heat Target"). Must be set before register_number().
    if NUMBER_TYPES[config[CONF_TYPE]]["zoned"]:
        dev_id = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    var = cg.new_Pvariable(config[CONF_ID])
    await number.register_number(
        var, config, min_value=MIN_C, max_value=MAX_C, step=1.0
    )
    if NUMBER_TYPES[config[CONF_TYPE]]["zoned"]:
        cg.add(var.set_zone(config[CONF_ZONE]))
    cg.add(var.set_number_type(config[CONF_TYPE]))
    await register_infinitesp_entity(var, config)
