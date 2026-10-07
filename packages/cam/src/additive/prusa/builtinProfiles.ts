// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Chili3d's built-in printer profiles, written as a PrusaSlicer config bundle so they go
 * through the same parser, inheritance and machine mapping as an imported vendor bundle.
 *
 * Source and license: the selection and the set of options follow the layout of
 * PrusaSlicer's public vendor bundles (PrusaSlicer is © Prusa Research, AGPL-3.0;
 * https://github.com/prusa3d/PrusaSlicer-settings-prusa-fff), and the build volumes are the
 * printers' published specifications. No vendor file is copied: the values are Chili3d's own
 * rounded choices and the start/end G-code was written for Chili3d. Like this repository the
 * file is AGPL-3.0. For the exact vendor presets, import PrusaSlicer's own bundle
 * (`importPrusaConfig`) or open the exported 3MF in PrusaSlicer with its system presets.
 *
 * Printers: Original Prusa MK4S, MK4 (input shaper), MK3S/MK3S+, MINI/MINI+, XL (single
 * tool), Prusa CORE One, a generic Creality Ender-3 and a Voron 2.4 350 (Klipper). Print
 * presets come in a "fast" family (input-shaped printers) and a "standard" one, selected by
 * the CHILI3D_SPEED_* keyword in the printer notes; filaments are generic PLA, PETG and ASA.
 */
export const BUILTIN_PRUSA_BUNDLE = String.raw`
# Chili3d built-in printer profiles (PrusaSlicer config bundle format). See builtinProfiles.ts.

[vendor]
name = Chili3d
config_version = 1.0.0

# ------------------------------------------------------------------ print presets

[print:*common*]
layer_height = 0.2
first_layer_height = 0.2
perimeters = 2
top_solid_layers = 5
bottom_solid_layers = 4
top_solid_min_thickness = 0.7
bottom_solid_min_thickness = 0.5
fill_density = 15%
fill_pattern = grid
top_fill_pattern = monotonic
bottom_fill_pattern = monotonic
fill_angle = 45
infill_overlap = 10%
solid_infill_below_area = 0
external_perimeters_first = 0
seam_position = aligned
seam_gap = 15%
extrusion_width = 0.45
first_layer_extrusion_width = 0.42
perimeter_extrusion_width = 0.45
external_perimeter_extrusion_width = 0.45
infill_extrusion_width = 0.45
solid_infill_extrusion_width = 0.45
top_infill_extrusion_width = 0.4
support_material_extrusion_width = 0.36
skirts = 1
skirt_distance = 2
skirt_height = 1
min_skirt_length = 4
brim_width = 0
brim_separation = 0
support_material = 0
support_material_auto = 1
support_material_threshold = 55
support_material_contact_distance = 0.2
support_material_spacing = 2
support_material_angle = 0
support_material_interface_layers = 2
support_material_interface_spacing = 0.2
support_material_xy_spacing = 60%
support_material_buildplate_only = 0
elefant_foot_compensation = 0.2
xy_size_compensation = 0
only_retract_when_crossing_perimeters = 0
gcode_resolution = 0.0125
gcode_label_objects = octoprint
compatible_printers_condition = nozzle_diameter[0]==0.4

[print:*standard*]
inherits = *common*
perimeter_speed = 45
external_perimeter_speed = 25
small_perimeter_speed = 25
infill_speed = 80
solid_infill_speed = 80
top_solid_infill_speed = 40
gap_fill_speed = 40
support_material_speed = 50
support_material_interface_speed = 80%
bridge_speed = 30
travel_speed = 150
travel_speed_z = 12
first_layer_speed = 20
max_print_speed = 200
default_acceleration = 1000
perimeter_acceleration = 800
infill_acceleration = 1250
bridge_acceleration = 1000
first_layer_acceleration = 800
travel_acceleration = 1250
compatible_printers_condition = printer_notes=~/.*CHILI3D_SPEED_STANDARD.*/ and nozzle_diameter[0]==0.4

[print:*fast*]
inherits = *common*
perimeter_speed = 120
external_perimeter_speed = 80
small_perimeter_speed = 60
infill_speed = 160
solid_infill_speed = 150
top_solid_infill_speed = 80
gap_fill_speed = 60
support_material_speed = 120
support_material_interface_speed = 70%
bridge_speed = 40
travel_speed = 250
travel_speed_z = 12
first_layer_speed = 30
max_print_speed = 300
default_acceleration = 2500
perimeter_acceleration = 2000
infill_acceleration = 4000
bridge_acceleration = 1500
first_layer_acceleration = 800
travel_acceleration = 4000
compatible_printers_condition = printer_notes=~/.*CHILI3D_SPEED_FAST.*/ and nozzle_diameter[0]==0.4

[print:0.10mm DETAIL]
inherits = *standard*
layer_height = 0.1
first_layer_height = 0.2
top_solid_layers = 8
bottom_solid_layers = 6
perimeter_speed = 40
external_perimeter_speed = 20
infill_speed = 60
solid_infill_speed = 60

[print:0.15mm QUALITY]
inherits = *standard*
layer_height = 0.15
top_solid_layers = 6
bottom_solid_layers = 5

[print:0.20mm QUALITY]
inherits = *standard*

[print:0.30mm DRAFT]
inherits = *standard*
layer_height = 0.3
first_layer_height = 0.3
top_solid_layers = 4
bottom_solid_layers = 3
extrusion_width = 0.5
perimeter_extrusion_width = 0.5
external_perimeter_extrusion_width = 0.5
infill_extrusion_width = 0.5
solid_infill_extrusion_width = 0.5
first_layer_extrusion_width = 0.5

[print:0.15mm SPEED]
inherits = *fast*
layer_height = 0.15
top_solid_layers = 6
bottom_solid_layers = 5

[print:0.20mm SPEED]
inherits = *fast*

[print:0.20mm STRUCTURAL]
inherits = *fast*
perimeters = 3
fill_density = 25%
fill_pattern = gyroid
perimeter_speed = 80
external_perimeter_speed = 45
infill_speed = 120

[print:0.25mm SPEED]
inherits = *fast*
layer_height = 0.25
first_layer_height = 0.25
top_solid_layers = 4
bottom_solid_layers = 3

# ------------------------------------------------------------------ filament presets

[filament:*common*]
filament_diameter = 1.75
extrusion_multiplier = 1
filament_max_volumetric_speed = 15
cooling = 1
fan_always_on = 1
bridge_fan_speed = 100
disable_fan_first_layers = 1
start_filament_gcode = "; filament start\n"
end_filament_gcode = "; filament end\n"

[filament:Generic PLA]
inherits = *common*
filament_type = PLA
filament_density = 1.24
filament_cost = 25
temperature = 210
first_layer_temperature = 215
bed_temperature = 60
first_layer_bed_temperature = 60
min_fan_speed = 100
max_fan_speed = 100
fan_below_layer_time = 100
slowdown_below_layer_time = 10
min_print_speed = 15

[filament:Generic PETG]
inherits = *common*
filament_type = PETG
filament_density = 1.27
filament_cost = 27
filament_max_volumetric_speed = 9
temperature = 240
first_layer_temperature = 235
bed_temperature = 90
first_layer_bed_temperature = 85
min_fan_speed = 30
max_fan_speed = 50
bridge_fan_speed = 60
disable_fan_first_layers = 3
fan_below_layer_time = 20
slowdown_below_layer_time = 20
min_print_speed = 15

[filament:Generic ASA]
inherits = *common*
filament_type = ASA
filament_density = 1.07
filament_cost = 30
filament_max_volumetric_speed = 12
temperature = 260
first_layer_temperature = 255
bed_temperature = 105
first_layer_bed_temperature = 100
fan_always_on = 0
min_fan_speed = 15
max_fan_speed = 15
bridge_fan_speed = 25
disable_fan_first_layers = 4
fan_below_layer_time = 30
slowdown_below_layer_time = 20
min_print_speed = 15

# ------------------------------------------------------------------ printer presets

[printer:*common*]
printer_technology = FFF
gcode_flavor = marlin2
nozzle_diameter = 0.4
use_relative_e_distances = 1
use_firmware_retraction = 0
retract_length = 0.8
retract_speed = 35
deretract_speed = 0
retract_lift = 0.2
retract_before_travel = 1.5
retract_layer_change = 1
retract_restart_extra = 0
wipe = 0
min_layer_height = 0.07
max_layer_height = 0.3
autoemit_temperature_commands = 1
binary_gcode = 0
machine_limits_usage = time_estimate_only
machine_max_feedrate_x = 200
machine_max_feedrate_y = 200
machine_max_feedrate_z = 12
machine_max_feedrate_e = 120
machine_max_acceleration_x = 1000
machine_max_acceleration_y = 1000
machine_max_acceleration_z = 200
machine_max_acceleration_e = 5000
machine_max_acceleration_extruding = 1250
machine_max_acceleration_retracting = 1250
machine_max_acceleration_travel = 1250
machine_max_jerk_x = 8
machine_max_jerk_y = 8
machine_max_jerk_z = 0.4
machine_max_jerk_e = 4.5
before_layer_gcode = ;BEFORE_LAYER_CHANGE\n;[layer_z]
layer_gcode = ;AFTER_LAYER_CHANGE\n;[layer_z]
default_filament_profile = "Generic PLA"

[printer:*prusa*]
inherits = *common*
chili3d_vendor = Prusa Research
machine_limits_usage = emit_to_gcode
end_gcode = {if max_layer_z < max_print_height}G1 Z{min(max_layer_z + 10, max_print_height)} F720 ; lift away from the print{endif}\nG1 X{print_bed_min[0] + 10} Y{print_bed_max[1] - 10} F4200 ; present the print\nM104 S0 ; nozzle heater off\nM140 S0 ; bed heater off\nM107 ; fan off\nM84 X Y E ; motors off (Z stays powered)

[printer:*prusa buddy*]
inherits = *prusa*
start_gcode = M862.3 P "[printer_model]" ; printer model check\nM862.1 P[nozzle_diameter] ; nozzle diameter check\nM17 ; enable steppers\nM140 S[first_layer_bed_temperature] ; heat the bed\nM104 S170 ; probing temperature: warm, but below oozing\nG90 ; absolute positioning\nM83 ; relative extrusion\nG28 ; home all axes\nM190 S[first_layer_bed_temperature] ; wait for the bed\nM109 S170 ; wait for the probing temperature\nG29 ; mesh bed leveling\nM104 S[first_layer_temperature] ; heat up for printing\nG1 X10 Y1 Z5 F6000 ; go to the purge line\nM109 S[first_layer_temperature] ; wait for the nozzle\nG1 Z0.3 F720\nG1 X70 E9 F1000 ; purge line\nG1 X110 E3 F1000\nG1 Z2 F720 ; lift off the purge line

[printer:Original Prusa MK4S 0.4 nozzle]
inherits = *prusa buddy*
chili3d_machine_id = prusa-mk4s
printer_model = MK4S
printer_variant = 0.4
printer_notes = Keywords for compatible presets:\nPRINTER_VENDOR_PRUSA3D\nPRINTER_MODEL_MK4S\nCHILI3D_SPEED_FAST
bed_shape = 0x0,250x0,250x210,0x210
max_print_height = 220
retract_length = 0.7
machine_max_feedrate_x = 400
machine_max_feedrate_y = 400
machine_max_acceleration_x = 4000
machine_max_acceleration_y = 4000
machine_max_acceleration_extruding = 4000
machine_max_acceleration_travel = 5000
default_print_profile = 0.20mm SPEED

[printer:Original Prusa MK4 Input Shaper 0.4 nozzle]
inherits = *prusa buddy*
chili3d_machine_id = prusa-mk4
printer_model = MK4
printer_variant = 0.4
printer_notes = Keywords for compatible presets:\nPRINTER_VENDOR_PRUSA3D\nPRINTER_MODEL_MK4\nCHILI3D_SPEED_FAST
bed_shape = 0x0,250x0,250x210,0x210
max_print_height = 220
retract_length = 0.7
machine_max_feedrate_x = 300
machine_max_feedrate_y = 300
machine_max_acceleration_x = 4000
machine_max_acceleration_y = 4000
machine_max_acceleration_extruding = 4000
machine_max_acceleration_travel = 4000
default_print_profile = 0.20mm SPEED

[printer:Original Prusa i3 MK3S & MK3S+]
inherits = *prusa*
chili3d_machine_id = prusa-mk3s
printer_model = MK3S
printer_variant = 0.4
printer_notes = Keywords for compatible presets:\nPRINTER_VENDOR_PRUSA3D\nPRINTER_MODEL_MK3S\nCHILI3D_SPEED_STANDARD
bed_shape = 0x0,250x0,250x210,0x210
max_print_height = 210
retract_lift = 0.4
start_gcode = M862.3 P "[printer_model]" ; printer model check\nM862.1 P[nozzle_diameter] ; nozzle diameter check\nG90 ; absolute positioning\nM83 ; relative extrusion\nM104 S[first_layer_temperature] ; heat the nozzle\nM140 S[first_layer_bed_temperature] ; heat the bed\nM190 S[first_layer_bed_temperature] ; wait for the bed\nM109 S[first_layer_temperature] ; wait for the nozzle\nG28 W ; home all axes without mesh leveling\nG80 ; mesh bed leveling\nG1 X10 Y1 Z0.3 F6000 ; go to the purge line\nG1 X70 E9 F1000 ; purge line\nG1 X110 E3 F1000\nG1 Z2 F720 ; lift off the purge line
default_print_profile = 0.20mm QUALITY

[printer:Original Prusa MINI & MINI+]
inherits = *prusa buddy*
chili3d_machine_id = prusa-mini
printer_model = MINI
printer_variant = 0.4
printer_notes = Keywords for compatible presets:\nPRINTER_VENDOR_PRUSA3D\nPRINTER_MODEL_MINI\nCHILI3D_SPEED_STANDARD
bed_shape = 0x0,180x0,180x180,0x180
max_print_height = 180
retract_length = 3.2
retract_speed = 70
deretract_speed = 40
machine_max_feedrate_x = 180
machine_max_feedrate_y = 180
default_print_profile = 0.20mm QUALITY

[printer:Original Prusa XL 0.4 nozzle]
inherits = *prusa buddy*
chili3d_machine_id = prusa-xl
printer_model = XL
printer_variant = 0.4
printer_notes = Keywords for compatible presets:\nPRINTER_VENDOR_PRUSA3D\nPRINTER_MODEL_XL\nCHILI3D_SPEED_FAST
bed_shape = 0x0,360x0,360x360,0x360
max_print_height = 360
retract_length = 0.7
machine_max_feedrate_x = 400
machine_max_feedrate_y = 400
machine_max_acceleration_x = 4000
machine_max_acceleration_y = 4000
machine_max_acceleration_extruding = 4000
machine_max_acceleration_travel = 5000
default_print_profile = 0.20mm SPEED

[printer:Prusa CORE One 0.4 nozzle]
inherits = *prusa buddy*
chili3d_machine_id = prusa-core-one
printer_model = COREONE
printer_variant = 0.4
printer_notes = Keywords for compatible presets:\nPRINTER_VENDOR_PRUSA3D\nPRINTER_MODEL_COREONE\nCHILI3D_SPEED_FAST
bed_shape = 0x0,250x0,250x220,0x220
max_print_height = 270
retract_length = 0.7
machine_max_feedrate_x = 400
machine_max_feedrate_y = 400
machine_max_acceleration_x = 5000
machine_max_acceleration_y = 5000
machine_max_acceleration_extruding = 5000
machine_max_acceleration_travel = 5000
default_print_profile = 0.20mm SPEED

[printer:Creality Ender-3]
inherits = *common*
chili3d_machine_id = creality-ender-3
chili3d_vendor = Creality
gcode_flavor = marlin
printer_model = ENDER3
printer_notes = Keywords for compatible presets:\nCHILI3D_SPEED_STANDARD
bed_shape = 0x0,220x0,220x220,0x220
max_print_height = 250
retract_length = 5
retract_speed = 40
retract_lift = 0
retract_before_travel = 2
machine_max_feedrate_x = 300
machine_max_feedrate_y = 300
machine_max_feedrate_z = 5
machine_max_acceleration_x = 500
machine_max_acceleration_y = 500
machine_max_acceleration_extruding = 500
machine_max_acceleration_travel = 500
machine_max_jerk_x = 10
machine_max_jerk_y = 10
start_gcode = G90 ; absolute positioning\nM83 ; relative extrusion\nM140 S[first_layer_bed_temperature] ; heat the bed\nM104 S[first_layer_temperature] ; heat the nozzle\nG28 ; home all axes\nM190 S[first_layer_bed_temperature] ; wait for the bed\nM109 S[first_layer_temperature] ; wait for the nozzle\nG1 Z2 F600\nG1 X1 Y20 F5000 ; go to the purge lines on the left edge\nG1 Z0.28 F600\nG1 Y200 E15 F1500 ; first purge line\nG1 X1.4 F5000\nG1 Y20 E15 F1500 ; second purge line\nG1 Z2 F600 ; lift off the purge lines
end_gcode = G1 E-2 F2700 ; retract\n{if max_layer_z < max_print_height}G1 Z{min(max_layer_z + 10, max_print_height)} F600 ; lift away from the print{endif}\nG1 X0 Y{print_bed_max[1]} F3000 ; present the print\nM106 S0 ; fan off\nM104 S0 ; nozzle heater off\nM140 S0 ; bed heater off\nM84 X Y E ; motors off
default_print_profile = 0.20mm QUALITY

[printer:Voron 2.4 350]
inherits = *common*
chili3d_machine_id = voron-2-4-350
chili3d_vendor = Voron Design
gcode_flavor = klipper
printer_model = VORON24
printer_notes = Keywords for compatible presets:\nCHILI3D_SPEED_FAST
bed_shape = 0x0,350x0,350x350,0x350
max_print_height = 340
retract_length = 0.5
retract_speed = 40
retract_lift = 0.2
machine_max_feedrate_x = 500
machine_max_feedrate_y = 500
machine_max_feedrate_z = 30
machine_max_acceleration_x = 10000
machine_max_acceleration_y = 10000
machine_max_acceleration_extruding = 7000
machine_max_acceleration_travel = 10000
machine_max_jerk_x = 10
machine_max_jerk_y = 10
start_gcode = PRINT_START BED=[first_layer_bed_temperature] EXTRUDER=[first_layer_temperature] ; the printer's start macro (homing, gantry leveling)\nG90 ; absolute positioning\nM83 ; relative extrusion\nG1 X10 Y1 Z5 F6000 ; go to the purge line\nM109 S[first_layer_temperature] ; make sure the nozzle is hot\nG1 Z0.3 F600\nG1 X70 E9 F1000 ; purge line\nG1 X110 E3 F1000\nG1 Z2 F600 ; lift off the purge line
end_gcode = PRINT_END ; the printer's end macro
default_print_profile = 0.20mm SPEED
`;
