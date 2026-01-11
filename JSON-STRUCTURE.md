# HealthAutoExport JSON Structure

This document describes the structure of JSON files exported from HealthAutoExport that the Workout Importer plugin can parse.

## Root Structure

```json
{
  "data": {
    "workouts": [
      // Array of workout objects
    ]
  }
}
```

## Workout Object Fields

Each workout in the `workouts` array can contain the following fields:

### Required Fields (usually present)
- `id` (string): Unique identifier for the workout (UUID format)
- `name` (string): Workout type name (e.g., "Mind and Body", "Yoga", "Functional Strength Training", etc.)
- `start` (string): Start time in format "YYYY-MM-DD HH:MM:SS -TZ" (e.g., "2024-09-02 13:52:08 -0700")
- `end` (string): End time in same format as start
- `duration` (number): Duration in seconds (float)
- `metadata` (object): Usually an empty object `{}`

### Optional Fields (may or may not be present)
- `location` (string): Location type (e.g., "Indoor", "Outdoor")

### Nested Objects (with qty/units structure)

These fields follow a pattern of `{ "qty": number, "units": string }`:

- `activeEnergyBurned`
  - `qty`: Calories burned (number)
  - `units`: Usually "kcal"

- `intensity`
  - `qty`: Intensity value (number)
  - `units`: Usually "kcal/hr·kg"

- `temperature` (optional)
  - `qty`: Temperature value (number)
  - `units`: Usually "degF" (degrees Fahrenheit)

- `humidity` (optional)
  - `qty`: Humidity percentage (number)
  - `units`: Usually "%"

- `distance` (optional, appears in runs/cycling)
  - `qty`: Distance value (number)
  - `units`: Usually "mi" (miles) or "km"

## Example Workout Types

Based on the sample exports, common workout types include:
- "Mind and Body"
- "Yoga"
- "Functional Strength Training"
- "Traditional Strength Training"
- "Indoor Run"
- "Indoor Cycling"
- "Other"

## Key Mapping Examples

When setting up key mappings in the plugin settings, you can map nested fields using dot notation:

### Simple fields:
- `name` → `workoutName`
- `duration` → `durationSeconds`
- `location` → `location`

### Nested fields (qty/units):
- `activeEnergyBurned.qty` → `calories`
- `activeEnergyBurned.units` → `caloriesUnits`
- `intensity.qty` → `intensity`
- `intensity.units` → `intensityUnits`
- `temperature.qty` → `temperature`
- `temperature.units` → `temperatureUnits`
- `humidity.qty` → `humidity`
- `humidity.units` → `humidityUnits`
- `distance.qty` → `distance`
- `distance.units` → `distanceUnits`

### Date/time fields:
- `start` → `startTime`
- `end` → `endTime`

Note: The plugin automatically handles nested objects with `qty`/`units` structure by flattening them. For example, `activeEnergyBurned.qty` will become `calories` in YAML, and if `activeEnergyBurned.units` is mapped, it will become `caloriesUnits`.

## Sample File

See `sample-workout-export.json` in the repository root for a complete example with multiple workout types.
