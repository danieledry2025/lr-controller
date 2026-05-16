// lr-helper — IOKit HID device capture + CGEvent active tap + mouse click helper
// Modes:
//   lr-helper list                    → JSON list of HID devices to stdout
//   lr-helper capture <vid> <pid>     → seize device, stream key events as JSON to stdout
//   lr-helper tap                     → active CGEventTap, intercepts+consumes keyboard events
//   lr-helper click <x> <y>           → simulate left mouse click at screen coords

import Foundation
import IOKit
import IOKit.hid
import CoreGraphics

// ── Key name table (HID Keyboard/Keypad Usage Page 0x07) ─────────────────
let KEY_NAMES: [Int: String] = [
    4:"A",5:"B",6:"C",7:"D",8:"E",9:"F",10:"G",11:"H",
    12:"I",13:"J",14:"K",15:"L",16:"M",17:"N",18:"O",19:"P",
    20:"Q",21:"R",22:"S",23:"T",24:"U",25:"V",26:"W",27:"X",
    28:"Y",29:"Z",
    30:"1",31:"2",32:"3",33:"4",34:"5",
    35:"6",36:"7",37:"8",38:"9",39:"0",
    40:"ENTER",41:"ESC",42:"BACKSPACE",43:"TAB",44:"SPACE",
    45:"-",46:"=",47:"[",48:"]",49:"\\",
    51:";",52:"'",53:"`",54:",",55:".",56:"/",
    58:"F1",59:"F2",60:"F3",61:"F4",62:"F5",63:"F6",
    64:"F7",65:"F8",66:"F9",67:"F10",68:"F11",69:"F12",
    73:"INSERT",74:"HOME",75:"PAGEUP",
    76:"DELETE",77:"END",78:"PAGEDOWN",
    79:"RIGHT",80:"LEFT",81:"DOWN",82:"UP",
    83:"NUMLOCK",84:"NUM/",85:"NUM*",86:"NUM-",87:"NUM+",
    88:"NUMENTER",89:"NUM1",90:"NUM2",91:"NUM3",92:"NUM4",
    93:"NUM5",94:"NUM6",95:"NUM7",96:"NUM8",97:"NUM9",98:"NUM0",
    104:"F13",105:"F14",106:"F15",107:"F16",
    108:"F17",109:"F18",110:"F19",111:"F20",
]

// ── CGEvent virtual keycodes (Carbon kVK_*) ───────────────────────────────
let VK_NAMES: [Int: String] = [
    0:"A", 1:"S", 2:"D", 3:"F", 4:"H", 5:"G", 6:"Z", 7:"X", 8:"C", 9:"V",
    11:"B", 12:"Q", 13:"W", 14:"E", 15:"R", 16:"Y", 17:"T",
    18:"1", 19:"2", 20:"3", 21:"4", 22:"6", 23:"5",
    24:"=", 25:"9", 26:"7", 27:"-", 28:"8", 29:"0",
    30:"]", 31:"O", 32:"U", 33:"[", 34:"I", 35:"P",
    36:"ENTER", 37:"L", 38:"J", 39:"'", 40:"K", 41:";", 42:"\\",
    43:",", 44:"/", 45:"N", 46:"M", 47:".", 48:"TAB", 49:"SPACE",
    50:"`", 51:"BACKSPACE", 53:"ESC",
    96:"F5", 97:"F6", 98:"F7", 99:"F3", 100:"F8", 101:"F9",
    103:"F11", 105:"F13", 107:"F14", 109:"F10", 111:"F12", 113:"F15",
    115:"HOME", 116:"PGUP", 117:"DELETE", 118:"F4", 119:"END",
    120:"F2", 121:"PGDN", 122:"F1",
    123:"LEFT", 124:"RIGHT", 125:"DOWN", 126:"UP",
]

// Modifier virtual keycodes — pass through unchanged (don't consume)
let MOD_VKS: Set<Int> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]

// ── Global state ──────────────────────────────────────────────────────────
var gModBits: UInt8 = 0
var gTap: CFMachPort?

func gModStr() -> String {
    var s = ""
    if gModBits & (1<<3) != 0 || gModBits & (1<<7) != 0 { s += "⌘" }
    if gModBits & (1<<2) != 0 || gModBits & (1<<6) != 0 { s += "⌥" }
    if gModBits & (1<<0) != 0 || gModBits & (1<<4) != 0 { s += "⌃" }
    if gModBits & (1<<1) != 0 || gModBits & (1<<5) != 0 { s += "⇧" }
    return s
}

func gOutput(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let str  = String(data: data, encoding: .utf8) else { return }
    print(str)
    fflush(stdout)
}

// ── CGEventTap callback ───────────────────────────────────────────────────
// Global function (no context capture) to satisfy @convention(c) requirement.
func tapEventCallback(
    _ proxy: CGEventTapProxy,
    _ type: CGEventType,
    _ event: CGEvent,
    _ userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    // Re-enable tap if macOS disabled it due to slow processing
    if type == .tapDisabledByTimeout {
        if let t = gTap { CGEvent.tapEnable(tap: t, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    guard type == .keyDown || type == .keyUp else {
        return Unmanaged.passUnretained(event)
    }

    let vk = Int(event.getIntegerValueField(.keyboardEventKeycode))

    // Pass modifier keys through — preserve OS modifier state for other apps
    if MOD_VKS.contains(vk) { return Unmanaged.passUnretained(event) }

    let flags = event.flags
    var parts: [String] = []
    if flags.contains(.maskCommand)   { parts.append("⌘") }
    if flags.contains(.maskAlternate) { parts.append("⌥") }
    if flags.contains(.maskControl)   { parts.append("⌃") }
    if flags.contains(.maskShift)     { parts.append("⇧") }

    let base = VK_NAMES[vk] ?? "KEY\(vk)"
    let name = parts.isEmpty ? base : parts.joined() + "+" + base
    let evName = type == .keyDown ? "keydown" : "keyup"

    gOutput(["event": evName, "vkCode": vk, "name": name])
    return nil  // consume — prevents event from reaching any other application
}

// ── Main ──────────────────────────────────────────────────────────────────
let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: lr-helper <list|capture <vid> <pid>|tap|click <x> <y>>\n", stderr)
    exit(1)
}

switch args[1] {

// ── list: enumerate HID devices ──────────────────────────────────────────
case "list":
    let mgr = IOHIDManagerCreate(kCFAllocatorDefault, 0)
    IOHIDManagerSetDeviceMatching(mgr, nil)
    IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
    IOHIDManagerOpen(mgr, 0)
    Thread.sleep(forTimeInterval: 0.1)

    var result: [[String: Any]] = []
    var seen = Set<String>()
    if let devSet = IOHIDManagerCopyDevices(mgr) as? Set<IOHIDDevice> {
        for dev in devSet {
            let vid  = (IOHIDDeviceGetProperty(dev, kIOHIDVendorIDKey    as CFString) as? Int)    ?? 0
            let pid  = (IOHIDDeviceGetProperty(dev, kIOHIDProductIDKey   as CFString) as? Int)    ?? 0
            let name = (IOHIDDeviceGetProperty(dev, kIOHIDProductKey     as CFString) as? String) ?? "Unknown"
            let mfr  = (IOHIDDeviceGetProperty(dev, kIOHIDManufacturerKey as CFString) as? String) ?? ""
            let uPage = (IOHIDDeviceGetProperty(dev, kIOHIDPrimaryUsagePageKey as CFString) as? Int) ?? 0
            guard vid != 0 else { continue }
            let key = "\(vid):\(pid)"
            if !seen.contains(key) {
                seen.insert(key)
                result.append(["vendorId": vid, "productId": pid,
                               "name": name, "manufacturer": mfr,
                               "usagePage": uPage])
            }
        }
    }
    gOutput(["devices": result])
    exit(0)

// ── click: simulate left mouse click at screen coordinates ───────────────
case "click":
    guard args.count >= 4,
          let x = Double(args[2]),
          let y = Double(args[3]) else {
        fputs("Usage: lr-helper click <x> <y>\n", stderr); exit(1)
    }
    let pt  = CGPoint(x: x, y: y)
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
            mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.04)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
            mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
    exit(0)

// ── tap: active CGEventTap — intercepts and consumes keyboard events ──────
// Events from the XP-Pen driver (and all other keyboards) are captured here.
// Mapped keys are consumed; unmapped keys are re-injected by main.js via osascript.
case "tap":
    let eventMask = CGEventMask(
        (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
    )
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: eventMask,
        callback: tapEventCallback,
        userInfo: nil
    ) else {
        fputs("ERROR:tap creation failed — grant Accessibility in System Settings\n", stderr)
        exit(1)
    }
    gTap = tap
    guard let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
        fputs("ERROR:could not create run loop source\n", stderr)
        exit(1)
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    fputs("READY:tap\n", stderr)
    CFRunLoopRun()
    exit(0)

// ── capture: seize specific device and stream key events ─────────────────
case "capture":
    guard args.count >= 4,
          let vid = Int(args[2]),
          let pid = Int(args[3]) else {
        fputs("Usage: lr-helper capture <vendorId> <productId>\n", stderr); exit(1)
    }

    let matching: [String: Any] = [
        kIOHIDVendorIDKey:  vid,
        kIOHIDProductIDKey: pid,
    ]

    for seize in [true, false] {
        let opt = seize ? IOOptionBits(kIOHIDOptionsTypeSeizeDevice) : IOOptionBits(0)
        let mgr = IOHIDManagerCreate(kCFAllocatorDefault, opt)
        IOHIDManagerSetDeviceMatching(mgr, matching as CFDictionary)

        IOHIDManagerRegisterInputValueCallback(mgr, { _, _, _, value in
            let elem   = IOHIDValueGetElement(value)
            let page   = IOHIDElementGetUsagePage(elem)
            let usage  = Int(IOHIDElementGetUsage(elem))
            let intVal = IOHIDValueGetIntegerValue(value)

            guard page == 0x07 else { return }

            if usage >= 0xE0 && usage <= 0xE7 {
                let bit = UInt8(1 << (usage - 0xE0))
                if intVal > 0 { gModBits |= bit } else { gModBits &= ~bit }
            } else if usage > 3 {
                let base = KEY_NAMES[usage] ?? "KEY\(usage)"
                let m    = gModStr()
                let name = m.isEmpty ? base : "\(m)+\(base)"
                let evt  = intVal > 0 ? "keydown" : "keyup"
                gOutput(["event": evt, "usage": usage, "name": name])
            }
        }, nil)

        IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
        let r = IOHIDManagerOpen(mgr, opt)
        if r == kIOReturnSuccess {
            fputs(seize ? "READY:seized\n" : "READY:passive\n", stderr)
            CFRunLoopRun()
            exit(0)
        }
    }

    fputs("ERROR:could not open device\n", stderr)
    exit(1)

default:
    fputs("Unknown mode: \(args[1])\n", stderr)
    exit(1)
}
