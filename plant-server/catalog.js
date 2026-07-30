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
  },
  {
    id: "photoresistor",
    label: "Light (photoresistor)",
    source: "adc",
    pin_kind: "adc",
    default_name: "light",
    unit: "raw",
    range: [0, 4095],
    interval_ms: 1000,
    instructions: "Make a divider: photoresistor from 3V3 to GPIO {pin}, and a 10kΩ resistor from GPIO {pin} to GND. Read the middle at GPIO {pin}."
  },
  {
    id: "water_level",
    label: "Water level (analog)",
    source: "adc",
    pin_kind: "adc",
    default_name: "water",
    unit: "raw",
    range: [0, 4095],
    interval_ms: 2000,
    instructions: "Power (+) and ground (−) to the rails. Signal (S) to GPIO {pin}. Keep the electronics above the waterline."
  },
  {
    id: "mic_level",
    label: "Sound level (KY-038 analog)",
    source: "adc",
    pin_kind: "adc",
    default_name: "sound",
    unit: "raw",
    range: [0, 4095],
    interval_ms: 150,
    instructions: "KY-038: + to 3V3, G to GND, A0 (analog) to GPIO {pin}. Reads sound activity (jumpy, not a smooth level). Leave D0 unconnected."
  },
  {
    id: "mic_threshold",
    label: "Loud sound trigger (KY-038 digital)",
    source: "digital",             // same new source as the button — a HIGH/LOW read
    pin_kind: "adc",
    default_name: "loud",
    unit: "state",
    range: [0, 1],
    interval_ms: 100,
    instructions: "KY-038: + to 3V3, G to GND, D0 (digital) to GPIO {pin}. Turn the onboard screw until the LED just turns off in quiet; a loud sound (clap/voice) then triggers it. Leave A0 unconnected."
  },
  {
    id: "heartbeat_hw487",
    label: "Heartbeat (HW-487)",
    source: "adc",
    pin_kind: "adc",
    default_name: "pulse",
    unit: "raw",
    range: [0, 4095],
    interval_ms: 100,
    instructions: "VCC to 3V3, GND to GND. Signal (S) to GPIO {pin}. Rest a fingertip gently on the sensor; the raw signal rises and falls with each beat."
  },
  {
    id: "button",
    label: "Button (press)",
    source: "digital", pin_kind: "adc",
    default_name: "button", unit: "state", range: [0, 1], interval_ms: 200,
    instructions: "One leg to GPIO {pin}, the other to GND. Uses internal pull-up: pressed = 0, released = 1."
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
  },
  {
    id: "single_led",
    label: "LED (single)",
    type: "led",                    // NEW output type — needs a firmware branch
    pin_kind: "single_out",         // NEW pin_kind — needs allocator support (see below)
    default_name: "led",
    instructions: "LED long leg (+) to GPIO {pin} through a 220Ω resistor; short leg (−) to GND."
  },
  {
    id: "buzzer",
    label: "Buzzer",
    type: "buzzer",                 // NEW output type — needs a firmware branch
    pin_kind: "single_out",
    default_name: "buzzer",
    instructions: "Buzzer (+) to GPIO {pin}, (−) to GND. (Active buzzer: on/off.)"
  },
  {
    id: "servo_sm_s2309s",
    label: "Servo (SM-S2309S)",
    type: "servo",
    pin_kind: "single_out",
    default_name: "servo",
    instructions: "Servo signal (usually orange/white) to GPIO {pin}; red to 5V; brown/black to GND. Use an external 5V supply if it stutters."
  },
  {
    id: "speaker",
    label: "Speaker (tone)",
    type: "speaker",
    pin_kind: "single_out",
    default_name: "speaker",
    instructions: "Speaker (+) to GPIO {pin} through a ~100Ω resistor; (−) to GND. Plays a tone at the set pitch."
  }
];

module.exports = { CATALOG, OUTPUT_CATALOG };   // export both now

