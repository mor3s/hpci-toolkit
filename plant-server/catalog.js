// catalog.js — the sensors YOU are bringing. The single source of truth the app
// consults when a participant adds a sensor. Board-independent: this just lists
// the KINDS of sensors that exist, not what's plugged into any particular board.

const CATALOG = [
  {
    id: "soil_capacitive",
    label: "Soil moisture (capacitive)",
    source: "adc",              // read with analogRead on an ESP pin
    pin_kind: "adc",            // needs a free ADC pin from the pool
    default_name: "soil",
    unit: "raw",                // 0–4095; calibrate to % later
    range: [0, 4095],
    interval_ms: 5000,
    instructions: "Connect power and ground to the rails per the sheet. Plug the SIGNAL wire into GPIO {pin} (the app picked a free one)."
  },
  {
    id: "potentiometer",
    label: "Potentiometer (dial)",
    source: "adc",
    pin_kind: "adc",
    default_name: "dial",
    unit: "raw",
    range: [0, 4095],
    interval_ms: 200,
    instructions: "Outer pins to 3V3 and GND. Plug the MIDDLE (wiper) pin into GPIO {pin}."
  },
  {
    id: "bme680",
    label: "Air & climate (BME680)",
    source: "i2c",              // shares the I2C bus — no pin allocation
    pin_kind: "i2c",
    address: "0x77",
    default_name: "air",
    // a BME is ONE thing to add, but yields FOUR readings:
    channels: [
      { suffix: "temperature", unit: "C",   range: [0, 50] },
      { suffix: "humidity",    unit: "%",   range: [0, 100] },
      { suffix: "pressure",    unit: "hPa", range: [950, 1050] },
      { suffix: "gas",         unit: "kOhm",range: [0, 500] }
    ],
    interval_ms: 30000,
    instructions: "Connect to the I2C rail (SDA→21, SCL→22, plus 3V3 and GND) per the sheet. No pin to pick — it shares the bus."
  },
  {
    id: "bioelectric_ads",
    label: "Plant bioelectricity (ADS1115, differential)",
    source: "ads1115",          // read over I2C from the ADS chip
    pin_kind: "ads_channel",    // needs a free ADS channel-PAIR, not an ESP pin
    address: "0x48",
    mode: "differential",       // measures A0 minus A1
    channel: "0-1",             // the A0–A1 differential pair
    gain: "GAIN_TWOTHIRDS",     // ±6.144V range; we record it so the firmware can convert to mV
    default_name: "pulse",
    unit: "mV",
    range: [-200, 200],         // tiny, can go negative — that's why differential matters
    interval_ms: 200,
    instructions: "Wire the ADS to the I2C rail per the sheet. Clip A0 and A1 to the leaf (A1 NOT grounded). Selecting this sets the ADS to read the A0–A1 difference."
  }
];
const OUTPUT_CATALOG = [
  {
    id: "rgb_led",
    label: "RGB LED",
    type: "rgb",                 // tells the firmware how to drive it (3-channel PWM color)
    pin_kind: "rgb",             // needs THREE output pins allocated together
    default_name: "leaf_light",
    instructions: "Connect the LED's ground (longest leg, or marked −) to GND. Connect R→GPIO {r}, G→GPIO {g}, B→GPIO {b} as the app shows."
  }
];

module.exports = { CATALOG, OUTPUT_CATALOG };   // export both now

