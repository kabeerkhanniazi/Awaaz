"""Mock systems of record for the four commercial agents.

Each agent talks to the kind of backend it would talk to in production - a
clinic calendar, a distributor's ERP, an ISP's node map, a corporate service
desk. The data is in-memory and reseeded on restart, so a demo always starts
from a known state and nothing here can be damaged by a caller.

Every handler returns a plain dict. The transport turns it into the JSON string
the Voice Agent API expects in tool.result.
"""

import random
import re
import string
from datetime import datetime, timedelta, timezone

# Pakistan Standard Time. The agents quote local times to local callers.
PKT = timezone(timedelta(hours=5))


def now() -> datetime:
    return datetime.now(PKT)


def _id(prefix: str, n: int = 6) -> str:
    return prefix + "".join(random.choices(string.digits, k=n))


def _digits(value) -> str:
    """Callers say numbers out loud, so match on digits and ignore the rest."""
    return re.sub(r"\D", "", str(value or ""))


# ---------------------------------------------------------------------------
# 1. Northgate Family Practice - clinic front desk
# ---------------------------------------------------------------------------

DOCTORS = [
    {"name": "Dr. Ayesha Siddiqui", "specialty": "General Practice"},
    {"name": "Dr. Bilal Ahmed", "specialty": "General Practice"},
    {"name": "Dr. Farah Khan", "specialty": "Paediatrics"},
    {"name": "Dr. Imran Qureshi", "specialty": "Cardiology"},
]

PATIENTS = [
    {"mrn": "NG-4471", "name": "Kabir Khan Niazi", "phone": "03001234567",
     "insurance": "Sehat Sahulat", "dob": "1998-04-12"},
    {"mrn": "NG-3320", "name": "Sana Malik", "phone": "03219876543",
     "insurance": "Jubilee Health", "dob": "1985-11-03"},
    {"mrn": "NG-5902", "name": "Usman Tariq", "phone": "03335550111",
     "insurance": "Self-pay", "dob": "1972-06-27"},
]

APPOINTMENTS: list = []


def _slot_grid(days_ahead: int = 5) -> list:
    """A believable clinic day: 9-1 and 5-8, half-hour slots, some taken."""
    rng = random.Random(20260901)
    slots = []
    start = now().replace(minute=0, second=0, microsecond=0)
    for day in range(1, days_ahead + 1):
        date = (start + timedelta(days=day)).date()
        if date.weekday() == 6:  # Sunday, clinic closed
            continue
        for hour, minute in [(9, 0), (9, 30), (10, 0), (10, 30), (11, 0), (11, 30),
                             (12, 0), (17, 0), (17, 30), (18, 0), (18, 30), (19, 0)]:
            if rng.random() < 0.45:
                continue
            when = datetime(date.year, date.month, date.day, hour, minute, tzinfo=PKT)
            slots.append({
                "slot_id": f"S{when.strftime('%m%d%H%M')}",
                "starts_at": when.isoformat(),
                "spoken_time": when.strftime("%A %d %B, %-I:%M %p"),
                "doctor": rng.choice(DOCTORS)["name"],
            })
    return slots


SLOTS = _slot_grid()


def clinic_find_patient(args: dict) -> dict:
    phone = _digits(args.get("phone"))
    name = (args.get("name") or "").strip().lower()
    for p in PATIENTS:
        if phone and _digits(p["phone"]).endswith(phone[-7:]):
            return {"found": True, **p}
        if name and name in p["name"].lower():
            return {"found": True, **p}
    return {"found": False,
            "message": "No patient record matched. Treat them as a new patient and take their details."}


def clinic_get_available_slots(args: dict) -> dict:
    booked = {a["slot_id"] for a in APPOINTMENTS if a["status"] == "booked"}
    free = [s for s in SLOTS if s["slot_id"] not in booked]
    want = (args.get("preferred_day") or "").strip().lower()
    if want:
        free = [s for s in free if want in s["spoken_time"].lower()] or free
    if (args.get("time_of_day") or "").lower() == "morning":
        free = [s for s in free if int(s["starts_at"][11:13]) < 13] or free
    elif (args.get("time_of_day") or "").lower() in ("evening", "afternoon"):
        free = [s for s in free if int(s["starts_at"][11:13]) >= 13] or free
    return {"available": free[:4], "total_free": len(free)}


def clinic_book_appointment(args: dict) -> dict:
    slot_id = args.get("slot_id")
    slot = next((s for s in SLOTS if s["slot_id"] == slot_id), None)
    if not slot:
        return {"booked": False, "error": "That slot id is not on the calendar. Call get_available_slots again."}
    if any(a["slot_id"] == slot_id and a["status"] == "booked" for a in APPOINTMENTS):
        return {"booked": False, "error": "That slot was just taken. Offer another one."}
    ref = _id("APT-", 5)
    APPOINTMENTS.append({
        "reference": ref, "slot_id": slot_id, "status": "booked",
        "patient_name": args.get("patient_name"), "phone": args.get("phone"),
        "reason": args.get("reason"), "doctor": slot["doctor"],
        "spoken_time": slot["spoken_time"],
    })
    return {"booked": True, "reference": ref, "doctor": slot["doctor"],
            "spoken_time": slot["spoken_time"],
            "note": "Read the reference back to the patient one character at a time."}


def clinic_cancel_appointment(args: dict) -> dict:
    ref = (args.get("reference") or "").upper().replace(" ", "")
    for a in APPOINTMENTS:
        if a["reference"].upper() == ref and a["status"] == "booked":
            a["status"] = "cancelled"
            return {"cancelled": True, "reference": a["reference"], "freed": a["spoken_time"]}
    return {"cancelled": False, "error": "No live booking with that reference."}


def clinic_practice_info(args: dict) -> dict:
    return {
        "opening_hours": "Monday to Saturday, 9am to 1pm and 5pm to 8pm. Closed Sunday.",
        "address": "Block 6, PECHS, Karachi",
        "insurance_accepted": ["Sehat Sahulat", "Jubilee Health", "EFU Health", "Self-pay"],
        "consultation_fee_pkr": 2500,
        "walk_ins": "Walk-ins are seen after booked patients, subject to waiting time.",
    }


# ---------------------------------------------------------------------------
# 2. Meridian Supply - B2B distribution / order status
# ---------------------------------------------------------------------------

RETAILERS = {
    "MS-2041": {"shop": "Al-Madina Kiryana Store", "city": "Lahore", "owner": "Rizwan Sheikh",
                "credit_limit_pkr": 450000, "outstanding_pkr": 128400},
    "MS-3312": {"shop": "New Sunrise Mart", "city": "Karachi", "owner": "Hina Aslam",
                "credit_limit_pkr": 900000, "outstanding_pkr": 615000},
    "MS-1150": {"shop": "Bismillah General Store", "city": "Rawalpindi", "owner": "Tanveer Abbas",
                "credit_limit_pkr": 300000, "outstanding_pkr": 41200},
}

ORDERS = {
    "ORD-88213": {"retailer_id": "MS-2041", "status": "in_transit", "value_pkr": 184500,
                  "dispatched": "2 days ago", "eta": "tomorrow before 2pm",
                  "truck": "LES-4471", "driver_phone": "0301-4455661",
                  "lines": [{"sku": "FMCG-TEA-900", "name": "Tapal Danedar 900g", "qty": 48},
                            {"sku": "FMCG-OIL-5L", "name": "Dalda Cooking Oil 5L", "qty": 24}]},
    "ORD-88450": {"retailer_id": "MS-3312", "status": "delayed", "value_pkr": 402000,
                  "dispatched": "4 days ago", "eta": "Thursday, delayed by a depot backlog at Sukkur",
                  "truck": "KHI-9902", "driver_phone": "0333-7781200",
                  "lines": [{"sku": "FMCG-RICE-25", "name": "Basmati Rice 25kg", "qty": 60}]},
    "ORD-88501": {"retailer_id": "MS-1150", "status": "processing", "value_pkr": 76300,
                  "dispatched": None, "eta": "dispatch tonight, delivery in 2 days",
                  "truck": None, "driver_phone": None,
                  "lines": [{"sku": "FMCG-SOAP-12", "name": "Lifebuoy Soap 12-pack", "qty": 30}]},
}

INVENTORY = {
    "FMCG-TEA-900": {"name": "Tapal Danedar 900g", "on_hand": 1240, "price_pkr": 1450},
    "FMCG-OIL-5L": {"name": "Dalda Cooking Oil 5L", "on_hand": 0, "price_pkr": 4300,
                    "restock": "in 3 days"},
    "FMCG-RICE-25": {"name": "Basmati Rice 25kg", "on_hand": 310, "price_pkr": 8900},
    "FMCG-SOAP-12": {"name": "Lifebuoy Soap 12-pack", "on_hand": 88, "price_pkr": 1180},
}

RETURNS: list = []


def meridian_lookup_order(args: dict) -> dict:
    oid = (args.get("order_id") or "").upper().replace(" ", "")
    digits = _digits(oid)
    order = ORDERS.get(oid)
    if not order and digits:
        order = next((o for k, o in ORDERS.items() if _digits(k) == digits), None)
        oid = next((k for k in ORDERS if _digits(k) == digits), oid)
    if not order:
        return {"found": False, "error": "No order with that ID. Ask the retailer to read it again."}
    retailer = RETAILERS.get(order["retailer_id"], {})
    return {"found": True, "order_id": oid, "status": order["status"],
            "shop": retailer.get("shop"), "value_pkr": order["value_pkr"],
            "dispatched": order["dispatched"], "eta": order["eta"],
            "truck": order["truck"], "lines": order["lines"]}


def meridian_verify_retailer(args: dict) -> dict:
    rid = (args.get("retailer_id") or "").upper().replace(" ", "")
    digits = _digits(rid)
    if rid not in RETAILERS and digits:
        rid = next((k for k in RETAILERS if _digits(k) == digits), rid)
    r = RETAILERS.get(rid)
    if not r:
        return {"verified": False, "error": "That retailer ID is not on the ledger."}
    headroom = r["credit_limit_pkr"] - r["outstanding_pkr"]
    return {"verified": True, "retailer_id": rid, **r,
            "credit_headroom_pkr": headroom,
            "on_hold": headroom < 50000,
            "open_orders": [k for k, o in ORDERS.items() if o["retailer_id"] == rid]}


def meridian_check_inventory(args: dict) -> dict:
    sku = (args.get("sku") or "").upper().replace(" ", "")
    term = (args.get("product_name") or "").strip().lower()
    item = INVENTORY.get(sku)
    if not item and term:
        sku, item = next(((k, v) for k, v in INVENTORY.items()
                          if term in v["name"].lower()), (sku, None))
    if not item:
        return {"found": False, "error": "Not a stocked SKU."}
    return {"found": True, "sku": sku, **item, "in_stock": item["on_hand"] > 0}


def meridian_create_return(args: dict) -> dict:
    oid = (args.get("order_id") or "").upper().replace(" ", "")
    if oid not in ORDERS:
        return {"created": False, "error": "Cannot raise a return against an unknown order."}
    rma = _id("RMA-", 5)
    RETURNS.append({"rma": rma, "order_id": oid, "sku": args.get("sku"),
                    "qty": args.get("quantity"), "reason": args.get("reason"),
                    "status": "awaiting_pickup"})
    return {"created": True, "rma": rma, "status": "awaiting_pickup",
            "pickup": "Next scheduled delivery run to that shop, within 48 hours.",
            "note": "Read the RMA back one character at a time."}


# ---------------------------------------------------------------------------
# 3. Corvus Broadband - billing and outage line
# ---------------------------------------------------------------------------

NODES = {
    "KHI-CLIFTON-04": {"area": "Clifton Block 4, Karachi", "status": "outage",
                       "cause": "fibre cut during K-Electric grid work",
                       "eta": "restored by 9pm tonight", "affected": 1840},
    "LHR-DHA-11": {"area": "DHA Phase 5, Lahore", "status": "degraded",
                   "cause": "upstream congestion", "eta": "engineers on site now", "affected": 420},
    "ISB-F11-02": {"area": "F-11 Markaz, Islamabad", "status": "healthy",
                   "cause": None, "eta": None, "affected": 0},
}

CORVUS_ACCOUNTS = {
    "CB-77120": {"name": "Kabir Khan Niazi", "phone": "03001234567", "node": "KHI-CLIFTON-04",
                 "package": "Fibre 50Mbps Unlimited", "monthly_pkr": 4500,
                 "balance_pkr": 4500, "due": "in 6 days", "last_payment": "5 July, 4500 PKR"},
    "CB-64008": {"name": "Sana Malik", "phone": "03219876543", "node": "LHR-DHA-11",
                 "package": "Fibre 100Mbps Unlimited", "monthly_pkr": 7000,
                 "balance_pkr": 14000, "due": "overdue by 11 days", "last_payment": "2 June, 7000 PKR"},
    "CB-51993": {"name": "Usman Tariq", "phone": "03335550111", "node": "ISB-F11-02",
                 "package": "Fibre 25Mbps", "monthly_pkr": 2800,
                 "balance_pkr": 0, "due": "nothing outstanding", "last_payment": "1 August, 2800 PKR"},
}

CORVUS_TICKETS: list = []


def corvus_lookup_account(args: dict) -> dict:
    key = (args.get("account_id") or "").upper().replace(" ", "")
    phone = _digits(args.get("phone"))
    acct = CORVUS_ACCOUNTS.get(key)
    aid = key
    if not acct and phone:
        aid, acct = next(((k, v) for k, v in CORVUS_ACCOUNTS.items()
                          if _digits(v["phone"]).endswith(phone[-7:])), (key, None))
    if not acct and _digits(key):
        aid, acct = next(((k, v) for k, v in CORVUS_ACCOUNTS.items()
                          if _digits(k) == _digits(key)), (key, None))
    if not acct:
        return {"found": False, "error": "No account matched that number."}
    node = NODES.get(acct["node"], {})
    return {"found": True, "account_id": aid, "name": acct["name"],
            "package": acct["package"], "node": acct["node"], "area": node.get("area"),
            "node_status": node.get("status"),
            "hint": "If node_status is not healthy, lead with the outage before anything else."}


def corvus_check_node_status(args: dict) -> dict:
    node = (args.get("node") or "").upper().replace(" ", "")
    n = NODES.get(node)
    if not n:
        acct = CORVUS_ACCOUNTS.get((args.get("account_id") or "").upper())
        n = NODES.get(acct["node"]) if acct else None
        node = acct["node"] if acct else node
    if not n:
        return {"found": False, "error": "Unknown node."}
    return {"found": True, "node": node, **n,
            "healthy": n["status"] == "healthy"}


def corvus_billing_summary(args: dict) -> dict:
    aid = (args.get("account_id") or "").upper().replace(" ", "")
    acct = CORVUS_ACCOUNTS.get(aid)
    if not acct:
        return {"found": False, "error": "Unknown account."}
    return {"found": True, "account_id": aid, "package": acct["package"],
            "monthly_pkr": acct["monthly_pkr"], "balance_pkr": acct["balance_pkr"],
            "due": acct["due"], "last_payment": acct["last_payment"],
            "payment_channels": ["JazzCash", "EasyPaisa", "1Bill via any bank app"]}


def corvus_log_complaint(args: dict) -> dict:
    ref = _id("CB-T", 5)
    CORVUS_TICKETS.append({"ref": ref, "account_id": args.get("account_id"),
                           "issue": args.get("issue"), "status": "open"})
    return {"logged": True, "reference": ref,
            "sla": "A field engineer will call back within 4 working hours.",
            "note": "Read the reference back one character at a time."}


# ---------------------------------------------------------------------------
# 4. Halden Group - Tier-1 IT service desk
# ---------------------------------------------------------------------------

EMPLOYEES = {
    "HG-1042": {"name": "Kabir Khan Niazi", "dept": "Engineering", "manager": "Nadia Rehman",
                "email": "k.niazi@haldengroup.com", "locked": True, "mfa": True},
    "HG-2288": {"name": "Sana Malik", "dept": "Finance", "manager": "Asad Javed",
                "email": "s.malik@haldengroup.com", "locked": False, "mfa": True},
    "HG-3901": {"name": "Usman Tariq", "dept": "Operations", "manager": "Nadia Rehman",
                "email": "u.tariq@haldengroup.com", "locked": False, "mfa": False},
}

SOFTWARE_CATALOG = {
    "figma": {"licence": "Design seat", "auto_approve": False, "approver": "line manager"},
    "jira": {"licence": "Standard", "auto_approve": True, "approver": None},
    "vpn": {"licence": "Remote access", "auto_approve": True, "approver": None},
    "power bi": {"licence": "Pro", "auto_approve": False, "approver": "Finance systems owner"},
    "github copilot": {"licence": "Business", "auto_approve": False, "approver": "Engineering lead"},
}

HALDEN_TICKETS: list = []


def halden_verify_employee(args: dict) -> dict:
    eid = (args.get("employee_id") or "").upper().replace(" ", "")
    if eid not in EMPLOYEES and _digits(eid):
        eid = next((k for k in EMPLOYEES if _digits(k) == _digits(eid)), eid)
    e = EMPLOYEES.get(eid)
    if not e:
        return {"verified": False, "error": "That employee ID is not in the directory."}
    return {"verified": True, "employee_id": eid, **e}


def halden_reset_password(args: dict) -> dict:
    eid = (args.get("employee_id") or "").upper().replace(" ", "")
    e = EMPLOYEES.get(eid)
    if not e:
        return {"reset": False, "error": "Verify the employee before resetting anything."}
    if not e["mfa"]:
        return {"reset": False, "requires_ticket": True,
                "error": "No MFA enrolled, so identity cannot be proven over the phone. "
                         "Log a Level-2 ticket for an in-person reset."}
    e["locked"] = False
    temp = "Halden-" + "".join(random.choices(string.digits, k=4))
    return {"reset": True, "temporary_password": temp,
            "delivery": "Sent to the personal email on file and valid for 30 minutes.",
            "note": "Do not read the temporary password out loud. Tell them to check their personal email."}


def halden_unlock_account(args: dict) -> dict:
    eid = (args.get("employee_id") or "").upper().replace(" ", "")
    e = EMPLOYEES.get(eid)
    if not e:
        return {"unlocked": False, "error": "Unknown employee."}
    was = e["locked"]
    e["locked"] = False
    return {"unlocked": True, "was_locked": was,
            "message": "Active Directory account unlocked. Ask them to try signing in now."}


def halden_request_software(args: dict) -> dict:
    name = (args.get("software") or "").strip().lower()
    entry = next((v for k, v in SOFTWARE_CATALOG.items() if k in name or name in k), None)
    if not entry:
        return {"granted": False, "in_catalog": False,
                "error": "Not in the standard catalogue. Log a Level-2 ticket for procurement."}
    if entry["auto_approve"]:
        return {"granted": True, "licence": entry["licence"],
                "message": "Access granted, live within 15 minutes."}
    return {"granted": False, "in_catalog": True, "licence": entry["licence"],
            "approver": entry["approver"],
            "message": f"Needs sign-off from the {entry['approver']}. Raise the request and tell them it is pending approval."}


def halden_create_ticket(args: dict) -> dict:
    ref = _id("HG-INC", 5)
    HALDEN_TICKETS.append({"ref": ref, "employee_id": args.get("employee_id"),
                           "summary": args.get("summary"),
                           "priority": args.get("priority", "P3"), "status": "open"})
    return {"created": True, "reference": ref, "queue": "Level-2 Service Desk",
            "sla": "P3 tickets are picked up within one working day.",
            "note": "Read the reference back one character at a time."}


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

HANDLERS = {
    "clinic": {
        "find_patient": clinic_find_patient,
        "get_available_slots": clinic_get_available_slots,
        "book_appointment": clinic_book_appointment,
        "cancel_appointment": clinic_cancel_appointment,
        "practice_info": clinic_practice_info,
    },
    "meridian": {
        "lookup_order": meridian_lookup_order,
        "verify_retailer": meridian_verify_retailer,
        "check_inventory": meridian_check_inventory,
        "create_return": meridian_create_return,
    },
    "corvus": {
        "lookup_account": corvus_lookup_account,
        "check_node_status": corvus_check_node_status,
        "billing_summary": corvus_billing_summary,
        "log_complaint": corvus_log_complaint,
    },
    "halden": {
        "verify_employee": halden_verify_employee,
        "reset_password": halden_reset_password,
        "unlock_account": halden_unlock_account,
        "request_software": halden_request_software,
        "create_ticket": halden_create_ticket,
    },
    "buddy": {},
}


def dispatch(agent_id: str, tool: str, args: dict) -> dict:
    """Run one tool call. Never raises - the agent gets an error it can speak."""
    table = HANDLERS.get(agent_id)
    if table is None:
        return {"error": f"unknown agent '{agent_id}'"}
    fn = table.get(tool)
    if fn is None:
        return {"error": f"'{agent_id}' has no tool named '{tool}'"}
    try:
        return fn(args or {})
    except Exception as exc:  # a broken tool must not kill the call
        return {"error": f"tool failed: {exc.__class__.__name__}: {exc}"}
