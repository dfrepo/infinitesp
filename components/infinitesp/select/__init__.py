import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import select
from esphome.const import CONF_ID, CONF_NAME, CONF_TYPE, CONF_DEVICE_ID
from .. import (
    InfinitESPEntity,
    CONF_INFINITESP_ID,
    CONF_ZONED,
    infinitesp_ns,
    register_infinitesp_entity,
    zone_device_id,
    check_zone_binding,
    codegen_zoned,
    apply_type_presentation,
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
        "auto": True,
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
    # Per-zone HOLD axis: follow the schedule, hold permanently, or (readback
    # only) hold-until a time. "hold_until" is DISPLAY-ONLY: the thermostat
    # ignores timed-hold writes from the SAM (verified 2026-06-30), so it can be
    # reported when set on the physical thermostat but not set from HA.
    "hold_mode": {
        "zoned": True,
        "label": "Hold Mode",
        "options": ["schedule", "hold", "hold_until"],
    },
    # System-wide vacation. Readback from the thermostat's 0x0420 status broadcast
    # (bit 0x20). "off" CANCELS vacation via a 3B04 push (verified to cancel even a
    # thermostat-initiated vacation); "on" (activate from HA) is a future TODO, so
    # the card renders this read-only while vacation is inactive.
    "vacation": {
        "auto": True,
        "icon": "mdi:bag-suitcase",
        "zoned": False,
        "label": "Vacation",
        "options": ["off", "on"],
    },
}


def _default_name_from_type(config):
    """Default the entity name from its type so object_id == type (the contract)."""
    info = SELECT_TYPES.get(config.get(CONF_TYPE, ""))
    if info and CONF_NAME not in config:
        config[CONF_NAME] = info["label"]
    return config


def _validate_zone(config):
    """Strict: per-zone types need `zone: N` xor `zoned: yes`; global forbids both."""
    return check_zone_binding(
        config, SELECT_TYPES[config[CONF_TYPE]]["zoned"], f"select type '{config[CONF_TYPE]}'"
    )


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


def _default_presentation(config):
    """Pre-schema: inject the type's registry icon/entity_category defaults."""
    return apply_type_presentation(config, SELECT_TYPES.get(config.get(CONF_TYPE, "")))


CONFIG_SCHEMA = cv.All(
    _default_name_from_type,
    _validate_zone,
    _inject_device_id,
    _default_presentation,
    select.select_schema(InfinitESPSelect).extend(
        {
            cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(CONF_INFINITESP_ID),
            cv.Required(CONF_TYPE): cv.one_of(*SELECT_TYPES, lower=True),
            # No default: presence is meaningful — _validate_zone requires a
            # binding (zone: or zoned:) for per-zone types, forbids it for global.
            cv.Optional(CONF_ZONE): cv.int_range(min=1, max=8),
            cv.Optional(CONF_ZONED): cv.boolean,
        }
    ),
)


async def to_code(config):
    stype = config[CONF_TYPE]
    info = SELECT_TYPES[stype]

    async def build(c):
        var = cg.new_Pvariable(c[CONF_ID])
        await select.register_select(var, c, options=info["options"])
        if info["zoned"]:
            cg.add(var.set_zone(c.get(CONF_ZONE, 1)))
        cg.add(var.set_select_type(stype))
        await register_infinitesp_entity(var, c)

    if await codegen_zoned(config, InfinitESPSelect, build):
        return
    if info["zoned"] and CONF_ZONE in config:
        dev = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
        if dev is not None:
            config[CONF_DEVICE_ID] = dev
    await build(config)
