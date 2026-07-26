import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import select
from esphome.const import CONF_ID, CONF_NAME, CONF_TYPE, CONF_DEVICE_ID
from .. import (
    InfinitESPEntity,
    CONF_INFINITESP_ID,
    infinitesp_ns,
    register_infinitesp_entity,
    zone_device_id,
)

CONF_ZONE = "zone"

InfinitESPSelect = infinitesp_ns.class_("InfinitESPSelect", select.Select, InfinitESPEntity)

# type -> {zoned, label, options}. `type` is the binding contract: it drives the
# firmware behavior AND defaults the entity name so object_id == type. When the
# user omits `name`, we default it from `label` so a dashboard/card can bind by
# type regardless of the display name. `zoned` types require a `zone:` and
# auto-group under that zone's HA sub-device; global types forbid `zone:`.
SELECT_TYPES = {
    "system_mode": {
        "zoned": False,
        "label": "System Mode",
        "options": ["heat", "cool", "auto", "emergency_heat", "off"],
    },
    "fan_mode": {
        "zoned": True,
        "label": "Fan Mode",
        "options": ["auto", "low", "med", "high"],
    },
    # Per-zone comfort ACTIVITY (which setpoint set). home/away/sleep/wake are
    # writable (apply that comfort profile + hold); "manual" is read-only (the
    # custom-setpoints state, entered by changing a setpoint). This is the
    # thermostat's "activity" axis — orthogonal to hold_mode.
    "activity": {
        "zoned": True,
        "label": "Activity",
        "options": ["home", "away", "sleep", "wake", "manual"],
    },
    # Per-zone HOLD axis: follow the schedule, or hold the current setpoints.
    "hold_mode": {
        "zoned": True,
        "label": "Hold Mode",
        "options": ["schedule", "hold"],
    },
}


def _default_name_from_type(config):
    """Default the entity name from its type so object_id == type (the contract)."""
    info = SELECT_TYPES.get(config.get(CONF_TYPE, ""))
    if info and CONF_NAME not in config:
        config[CONF_NAME] = info["label"]
    return config


def _validate_zone(config):
    """Per-zone types require a zone:; global types forbid it."""
    zoned = SELECT_TYPES[config[CONF_TYPE]]["zoned"]
    has_zone = CONF_ZONE in config
    if zoned and not has_zone:
        raise cv.Invalid(f"select type '{config[CONF_TYPE]}' is per-zone; add 'zone:'")
    if not zoned and has_zone:
        raise cv.Invalid(f"select type '{config[CONF_TYPE]}' is global; remove 'zone:'")
    return config


def _inject_device_id(config):
    """Auto-attach zoned selects to their hub zone sub-device before the base
    schema's duplicate-name validator runs (so two zones can each have a 'Fan
    Mode' / 'Profile'). Resolved against the hub's declared zone-device IDs."""
    if SELECT_TYPES.get(config.get(CONF_TYPE, ""), {}).get("zoned") and CONF_ZONE in config:
        hub_id = config.get(CONF_INFINITESP_ID)
        dev_id = zone_device_id(hub_id, config[CONF_ZONE]) if hub_id is not None else None
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    return config


CONFIG_SCHEMA = cv.All(
    _default_name_from_type,
    _validate_zone,
    _inject_device_id,
    select.select_schema(InfinitESPSelect).extend(
        {
            cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(CONF_INFINITESP_ID),
            cv.Required(CONF_TYPE): cv.one_of(*SELECT_TYPES, lower=True),
            # No default: presence is meaningful (required for zoned, forbidden
            # for global) — see _validate_zone.
            cv.Optional(CONF_ZONE): cv.int_range(min=1, max=8),
        }
    ),
)


async def to_code(config):
    stype = config[CONF_TYPE]
    info = SELECT_TYPES[stype]
    # Re-assert the zone sub-device attachment before register_select (mirrors the
    # number platform): device_id must be set before registration so per-device
    # name uniqueness applies and the entity attaches to the zone sub-device.
    if info["zoned"]:
        dev_id = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    var = cg.new_Pvariable(config[CONF_ID])
    await select.register_select(var, config, options=info["options"])
    if info["zoned"]:
        cg.add(var.set_zone(config[CONF_ZONE]))
    cg.add(var.set_select_type(stype))
    await register_infinitesp_entity(var, config)
