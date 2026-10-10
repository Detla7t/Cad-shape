FeatureScript 2931;
import(path : "onshape/std/table.fs", version : "2931.0");
import(path : "onshape/std/common.fs", version : "2931.0");

annotation { "Feature Type Name" : "Add My Functions" }
export const addMyFunctions = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
    }
    {
        setVariable(context, "sizeCrimp",
            function(x) returns ValueWithUnits {
                if (x <= 5 * inch)
                    return 3/8 * inch;
                if (x <= 8.625 * inch)
                    return 1/2 * inch;
                if (x <= 12.75 * inch)
                    return 5/8 * inch;
                if (x <= 18 * inch)
                    return 3/4 * inch;
                if (x <= 24 * inch)
                    return 1 * inch;
                return 1.5 * inch;
            }
        );
        setVariable(context, "sizeOverlap",
            function(x,y) returns ValueWithUnits {
                var Max_Overlap_Size = 1.5 * inch;
                var Overlap = (x - y);
                var Inverse_Overlap = (y - x);
                if (Overlap > Max_Overlap_Size)
                    return 1 * inch;
                if (Overlap <= 0 * inch)
                    return 1 * inch;
                    // return (((y/inch)-(x/inch)) * inch) / 2;
                return (((x/inch)-(y/inch)) * inch) / 2;
            }
        );
        // You can make more setVariable calls here to make more functions
    });
    

// ---- HELPER: Convert inch value to fraction string ----
function inchToFractionString(value is ValueWithUnits) returns string
{
    var inches = value / inch;
    var whole = floor(inches);
    var frac = inches - whole;

    var denom = 16;
    var num = round(frac * denom);

    // Handle rollover (e.g. 7.999 -> 8)
    if (num == denom)
    {
        whole += 1;
        num = 0;
    }

    if (num == 0)
    {
        return whole ~ "\"";
    }

    // Reduce fraction
    var gcdVal = gcd(num, denom);
    num /= gcdVal;
    denom /= gcdVal;

    if (whole == 0)
    {
        return num ~ "/" ~ denom ~ "\"";
    }

    return whole ~ " " ~ num ~ "/" ~ denom ~ "\"";
}


// ---- HELPER: Greatest Common Divisor ----
function gcd(a is number, b is number) returns number
{
    while (b != 0)
    {
        var temp = b;
        b = a % b;
        a = temp;
    }
    return a;
}


annotation { "Table Type Name" : "Standard_Sizes" } // Valid Standard OD/ID Sizes
export const sizeTable = defineTable(function(context is Context, definition is map) returns Table
precondition
{
    // No UI inputs needed for this example
}
{
    // ---- INPUT SIZES ----
    // Store as values (inches)
    const sizes = [
        4 * inch,       // 4
        4.5 * inch,     // 4 1/2
        5 * inch,       // 5
        5.5625 * inch,  // 5 9/16
        6.625 * inch,   // 6 5/8
        7.625 * inch,   // 7 5/8 
        8.625 * inch,   // 8 5/8
        9.625 * inch,   // 9 5/8
        10.75 * inch,   // 10 3/4
        11.75 * inch,   // 11 3/4
        12.75 * inch,   // 12 3/4
        14 * inch,      // 14
        15 * inch,      // 15
        16 * inch,      // 16
        17 * inch,      // 17
        18 * inch,       // 18
        19 * inch,      // 19
        20 * inch,      // 20
        21 * inch,      // 21
        22 * inch,      // 22
        23 * inch,      // 23
        24 * inch       // 24
    ];

    // ---- COLUMN DEFINITIONS ----
    var columns = [
        tableColumnDefinition("name", "Size"),
        tableColumnDefinition("od", "OD"),
        tableColumnDefinition("id", "ID")
    ];

    // ---- GENERATE VALID COMBINATIONS ----
    var rows = [];

    for (var i = 0; i < size(sizes); i += 1)
    {
        for (var j = 0; j < i; j += 1)
        {
            var od = sizes[i];
            var id = sizes[j];

            var name = inchToFractionString(od) ~ " x " ~ inchToFractionString(id);

            rows = append(rows, tableRow({
                "name" : name,
                "od"   : od,
                "id"   : id
            }));
        }
    }

    return table("Standard Sizes", columns, rows);
});
