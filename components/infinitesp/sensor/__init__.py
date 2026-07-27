import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import sensor
from esphome.const import CONF_ID, CONF_NAME, CONF_TYPE, CONF_DISABLED_BY_DEFAULT, CONF_ACCURACY_DECIMALS, CONF_DEVICE_ID, STATE_CLASS_MEASUREMENT, DEVICE_CLASS_TEMPERATURE, DEVICE_CLASS_VOLTAGE
from .. import (
    InfinitESPEntity,
    CONF_INFINITESP_ID,
    CONF_ZONED,
    infinitesp_ns,
    register_infinitesp_entity,
    zone_device_id,
    check_zone_binding,
    codegen_zoned,
    name_from_type,
    apply_type_presentation,
)

CONF_ZONE = "zone"
CONF_STATIC_K = "static_k"

# Per-zone sensor types (marked `"zoned": True`) auto-attach to their zone HA
# sub-device (like number/select). Everything else (ODU/IDU/global) stays on main.

InfinitESPSensor = infinitesp_ns.class_("InfinitESPSensor", sensor.Sensor, InfinitESPEntity)

SENSOR_TYPES = {
    # SAM/thermostat sensors — device_class 0 (any), they gate on register_key
    "temperature": {"key": "temperature", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 0, "zoned": True},
    "humidity": {"key": "humidity", "unit": "%", "bus_class": 0, "zoned": True},
    # outdoor_temperature: the THERMOSTAT/SAM's outdoor reading (bus_class 0, from
    # the SAM state), as opposed to odu_outdoor_temp which is the OUTDOOR UNIT's own
    # 0302 sensor (bus_class 5). They usually agree within ~1°; the card's "Outdoor
    # Temp" tile uses odu_outdoor_temp. Both are auto-generated.
    "outdoor_temperature": {"auto": True, "key": "outdoor_temperature", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 0},
    "vacation_min_temp": {"auto": True, "key": "vacation_min_temp", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 0, "icon": "mdi:thermometer-low", "entity_category": "diagnostic"},
    "vacation_max_temp": {"auto": True, "key": "vacation_max_temp", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 0, "icon": "mdi:thermometer-high", "entity_category": "diagnostic"},
    # IDU sensors — device class 4
    "blower_rpm": {"auto": True, "key": "blower_rpm", "unit": "RPM", "bus_class": 4, "icon": "mdi:fan", "entity_category": "diagnostic"},
    "blower_rpm_0404": {"key": "blower_rpm_0404", "unit": "RPM", "bus_class": 4, "disabled_by_default": True},
    "airflow_cfm": {"auto": True, "key": "airflow_cfm", "unit": "ft³/min", "bus_class": 4, "icon": "mdi:air-filter", "entity_category": "diagnostic"},
    # Blower motor power (register 0413, float32 BE watts) — the ECM load signal
    "blower_power": {"auto": True, "key": "blower_watts", "unit": "W", "bus_class": 4, "icon": "mdi:lightning-bolt", "entity_category": "diagnostic"},
    # Static pressure (in. w.c.), derived in firmware from blower watts + airflow:
    # SP = static_k * watts / cfm. Coefficient configurable via `static_k`.
    "static_pressure": {"auto": True, "key": "static_pressure", "unit": "inH2O", "bus_class": 4, "accuracy": 2, "icon": "mdi:gauge", "entity_category": "diagnostic"},
    # ODU sensors — device class 5
    # bare = actual (measured) RPM [2..3] (the original `compressor_rpm` read
    # [0..1] = target; re-pointed to actual). target_compressor_rpm [0..1] is
    # additive. Infinitude OutdoorUnit.pm 0604: target_rpm / current_rpm.
    "compressor_rpm": {"auto": True, "key": "compressor_rpm", "unit": "RPM", "bus_class": 5, "icon": "mdi:engine", "entity_category": "diagnostic"},
    "target_compressor_rpm": {"auto": True, "key": "target_compressor_rpm", "unit": "RPM", "bus_class": 5, "icon": "mdi:engine", "entity_category": "diagnostic"},
    "odu_compressor_frequency": {"auto": True, "key": "compressor_frequency", "unit": "Hz", "bus_class": 5, "icon": "mdi:sine-wave", "entity_category": "diagnostic"},
    # ODU expansion valve position from register 0608 byte [2] (0-100 percent).
    # Ramps over 10-15s on cycle transitions; reads 0 (off) or 100 (running) otherwise.
    "odu_expansion_valve": {"auto": True, "key": "odu_expansion_valve", "unit": "%", "bus_class": 5, "icon": "mdi:valve", "entity_category": "diagnostic", "accuracy": 0},
    "odu_commanded_stage": {"auto": True, "key": "odu_commanded_stage", "unit": "", "bus_class": 5, "icon": "mdi:transmission-tower", "entity_category": "diagnostic"},
    "odu_stage": {"auto": True, "key": "odu_stage", "unit": "", "bus_class": 5, "icon": "mdi:step-forward", "entity_category": "diagnostic"},
    "odu_operating_mode": {"auto": True, "key": "odu_operating_mode", "unit": "", "bus_class": 5, "icon": "mdi:briefcase-edit", "entity_category": "diagnostic"},
    # ODU line voltage from register 0304 byte 7 (whole volts, state-independent)
    "odu_line_voltage": {"auto": True, "key": "odu_line_voltage", "unit": "V", "device_class": DEVICE_CLASS_VOLTAGE, "bus_class": 5, "accuracy": 0, "icon": "mdi:flash", "entity_category": "diagnostic"},
    # ODU IEEE754 float32 values from register 061f
    "superheat_target": {"auto": True, "key": "odu_float_1", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer", "entity_category": "diagnostic"},
    "superheat_actual": {"auto": True, "key": "odu_float_2", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer", "entity_category": "diagnostic"},
    "subcooling_target": {"auto": True, "key": "odu_float_3", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer-chevron-down", "entity_category": "diagnostic"},
    "subcooling_actual": {"auto": True, "key": "odu_float_4", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer-chevron-down", "entity_category": "diagnostic"},
    "odu_float_5": {"auto": True, "key": "odu_float_5", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer-alert", "entity_category": "diagnostic"},
    "odu_float_6": {"auto": True, "key": "odu_float_6", "unit": "", "bus_class": 5, "icon": "mdi:blur", "entity_category": "diagnostic", "accuracy": 3},
    # ODU register 0302 temperature measurements
    "odu_outdoor_temp": {"auto": True, "key": "odu_outdoor_temp", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer", "entity_category": "diagnostic"},
    "odu_coil_temp": {"auto": True, "key": "odu_coil_temp", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer", "entity_category": "diagnostic"},
    "odu_suction_temp": {"auto": True, "key": "odu_suction_temp", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer", "entity_category": "diagnostic"},
    "odu_suction_superheat": {"auto": True, "key": "odu_suction_superheat", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer-lines", "entity_category": "diagnostic"},
    "odu_indoor_ambient": {"key": "odu_indoor_ambient", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5},
    "odu_discharge_temp": {"auto": True, "key": "odu_discharge_temp", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 5, "icon": "mdi:thermometer", "entity_category": "diagnostic"},
    # ZC register 0302 (device class 6 = 0x60>>4). 24-byte TLV [tag,id,hi,lo],
    # °F = uint16_BE / 16. zone N -> id N; id 0x14 = LAT, id 0x1C = HPT.
    # LAT/HPT exist only on zone boards with those thermistor ports wired, so
    # they default to disabled (enable in HA if your board reports them).
    "zc_zone_temperature": {"key": "zc_zone_temperature", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 6, "zoned": True, "auto": False},
    "leaving_air_temperature": {"auto": True, "key": "zc_lat", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 6, "disabled_by_default": True},
    "hpt_temperature": {"auto": True, "key": "zc_hpt", "unit": "\u00b0C", "device_class": DEVICE_CLASS_TEMPERATURE, "bus_class": 6, "disabled_by_default": True},
    # ZC commanded damper position per zone (register 0308, 0-15 -> 0-100%).
    # Graphable numeric complement to the damper cover; reads 0308 (populated on
    # both primary and secondary controllers) rather than the 0319 feedback.
    "damper_position": {"key": "damper_position", "unit": "%", "bus_class": 6, "zoned": True},
    # IDU cycle counters (register 0310, 4-byte key-value entries) — device class 4
    "idu_low_heat_cycles": {"auto": True, "key": "idu_low_heat_cycles", "unit": "cycles", "bus_class": 4, "icon": "mdi:counter", "entity_category": "diagnostic"},

    "idu_high_heat_cycles": {"auto": True, "key": "idu_high_heat_cycles", "unit": "cycles", "bus_class": 4, "icon": "mdi:counter", "entity_category": "diagnostic"},

    "idu_med_heat_cycles": {"auto": True, "key": "idu_med_heat_cycles", "unit": "cycles", "bus_class": 4, "icon": "mdi:counter", "entity_category": "diagnostic"},

    "idu_blower_cycles": {"auto": True, "key": "idu_blower_cycles", "unit": "cycles", "bus_class": 4, "icon": "mdi:counter", "entity_category": "diagnostic"},

    "idu_poweron_cycles": {"auto": True, "key": "idu_poweron_cycles", "unit": "cycles", "bus_class": 4, "icon": "mdi:counter", "entity_category": "diagnostic"},

    # IDU runtime hours (register 0311, 4-byte key-value entries) — device class 4
    "idu_low_heat_hours": {"auto": True, "key": "idu_low_heat_hours", "unit": "h", "bus_class": 4, "icon": "mdi:timer-outline", "entity_category": "diagnostic"},

    "idu_high_heat_hours": {"auto": True, "key": "idu_high_heat_hours", "unit": "h", "bus_class": 4, "icon": "mdi:timer-outline", "entity_category": "diagnostic"},

    "idu_med_heat_hours": {"auto": True, "key": "idu_med_heat_hours", "unit": "h", "bus_class": 4, "icon": "mdi:timer-outline", "entity_category": "diagnostic"},

    "idu_blower_hours": {"auto": True, "key": "idu_blower_hours", "unit": "h", "bus_class": 4, "icon": "mdi:timer-outline", "entity_category": "diagnostic"},

    "idu_poweron_hours": {"auto": True, "key": "idu_poweron_hours", "unit": "h", "bus_class": 4, "icon": "mdi:timer-outline", "entity_category": "diagnostic"},

    # ODU cycle counters (register 0310) — device class 5
    "odu_heat_cycles": {"auto": True, "key": "odu_heat_cycles", "unit": "cycles", "bus_class": 5, "icon": "mdi:counter", "entity_category": "diagnostic"},

    "odu_cool_cycles": {"auto": True, "key": "odu_cool_cycles", "unit": "cycles", "bus_class": 5, "icon": "mdi:counter", "entity_category": "diagnostic"},

    "odu_defrost_cycles": {"auto": True, "key": "odu_defrost_cycles", "unit": "cycles", "bus_class": 5, "icon": "mdi:counter", "entity_category": "diagnostic"},

    "odu_poweron_cycles": {"auto": True, "key": "odu_poweron_cycles", "unit": "cycles", "bus_class": 5, "icon": "mdi:counter", "entity_category": "diagnostic"},

    # ODU runtime hours (register 0311) — device class 5
    "odu_heat_hours": {"auto": True, "key": "odu_heat_hours", "unit": "h", "bus_class": 5, "icon": "mdi:timer-outline", "entity_category": "diagnostic"},

    "odu_cool_hours": {"auto": True, "key": "odu_cool_hours", "unit": "h", "bus_class": 5, "icon": "mdi:timer-outline", "entity_category": "diagnostic"},

    "odu_defrost_hours": {"auto": True, "key": "odu_defrost_hours", "unit": "h", "bus_class": 5, "icon": "mdi:timer-outline", "entity_category": "diagnostic"},

    "odu_poweron_hours": {"auto": True, "key": "odu_poweron_hours", "unit": "h", "bus_class": 5, "icon": "mdi:timer-outline", "entity_category": "diagnostic"},

}

def _default_name(config):
    """Default the entity name from its `type` when omitted, so object_id == type
    (e.g. type: temperature -> "Temperature" -> object_id "temperature"). An
    explicit `name:` still wins (curated global sensors keep their labels)."""
    if CONF_NAME not in config and CONF_TYPE in config:
        config[CONF_NAME] = name_from_type(config[CONF_TYPE])
    return config


def _inject_device_id(config):
    """Pre-schema: attach per-zone sensors to their zone HA sub-device (before the
    base schema's duplicate-name validator, so every zone can share e.g. the name
    "Temperature"). Global sensor types stay on the main node."""
    if SENSOR_TYPES.get(config.get(CONF_TYPE), {}).get("zoned") and CONF_ZONE in config:
        dev_id = zone_device_id(config.get(CONF_INFINITESP_ID), config[CONF_ZONE])
        if dev_id is not None:
            config[CONF_DEVICE_ID] = dev_id
    return config


def _apply_sensor_type(config):
    """Inject unit/device_class from SENSOR_TYPES and force disabled_by_default
    for sensor types that opt into it (e.g. zc_lat/zc_hpt)."""
    info = SENSOR_TYPES[config[CONF_TYPE]]
    config[sensor.CONF_UNIT_OF_MEASUREMENT] = info["unit"]
    config[sensor.CONF_DEVICE_CLASS] = info.get("device_class", "")
    if "accuracy" in info:
        config[CONF_ACCURACY_DECIMALS] = info["accuracy"]
    if info.get("disabled_by_default"):
        config[CONF_DISABLED_BY_DEFAULT] = True
    return config


def _validate_zone_binding(config):
    """Strict: per-zone types need `zone: N` xor `zoned: yes`; global forbids both.
    (Invalid types are reported by the base schema's one_of, so ignore them here.)"""
    info = SENSOR_TYPES.get(config.get(CONF_TYPE))
    if info is None:
        return config
    return check_zone_binding(config, info.get("zoned"), f"sensor type '{config[CONF_TYPE]}'")


def _default_presentation(config):
    """Pre-schema: inject the type's registry icon/entity_category defaults."""
    return apply_type_presentation(config, SENSOR_TYPES.get(config.get(CONF_TYPE)))


CONFIG_SCHEMA = cv.All(
    _validate_zone_binding,
    _default_name,
    _inject_device_id,
    _default_presentation,
    cv.Schema({cv.Required(CONF_TYPE): cv.one_of(*SENSOR_TYPES, lower=True)}).extend(
        sensor.sensor_schema(
            InfinitESPSensor,
            accuracy_decimals=1,
            state_class=STATE_CLASS_MEASUREMENT,
        ).extend(
            {
                cv.GenerateID(CONF_INFINITESP_ID): cv.use_id(CONF_INFINITESP_ID),
                cv.Optional(CONF_ZONE): cv.int_range(min=1, max=8),
                cv.Optional(CONF_ZONED): cv.boolean,
                cv.Optional(CONF_STATIC_K, default=2.046): cv.float_,
            }
        )
    ),
    _apply_sensor_type,
)


async def to_code(config):
    info = SENSOR_TYPES[config[CONF_TYPE]]

    async def build(c):
        var = cg.new_Pvariable(c[CONF_ID])
        await sensor.register_sensor(var, c)
        cg.add(var.set_zone(c.get(CONF_ZONE, 1)))
        cg.add(var.set_sensor_type(info["key"]))
        cg.add(var.set_bus_class(info.get("bus_class", 0)))
        cg.add(var.set_static_k(c[CONF_STATIC_K]))
        await register_infinitesp_entity(var, c)

    if await codegen_zoned(config, InfinitESPSensor, build):
        return
    if info.get("zoned") and CONF_ZONE in config:
        dev = zone_device_id(config[CONF_INFINITESP_ID], config[CONF_ZONE])
        if dev is not None:
            config[CONF_DEVICE_ID] = dev
    await build(config)
