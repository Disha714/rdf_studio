def clean_events(events):
    cleaned = []
    for row in events:
        try:
            value = float(row.get("value"))
        except (TypeError, ValueError):
            continue
        category = (row.get("category") or "").strip().upper()
        region = (row.get("region") or "").strip().lower()
        timestamp = (row.get("timestamp") or "").strip()
        if not category or not region or not timestamp:
            continue
        cleaned.append({
            "id": row.get("id"),
            "timestamp": timestamp,
            "category": category,
            "value": value,
            "region": region,
        })
    return cleaned


def transform_events(cleaned):
    enriched = []
    for row in cleaned:
        row = dict(row)
        row["value_per_hour"] = round(row["value"], 2)
        row["is_weekend"] = False
        enriched.append(row)
    return enriched


def aggregate_events(enriched):
    totals = {}
    counts = {}
    for row in enriched:
        key = (row["category"], row["region"])
        totals[key] = totals.get(key, 0.0) + row["value"]
        counts[key] = counts.get(key, 0) + 1
    summary = []
    for (category, region), total in totals.items():
        summary.append({
            "category": category,
            "region": region,
            "average_value": round(total / counts[(category, region)], 2),
            "count": counts[(category, region)],
        })
    return summary


def build_report(summary):
    lines = ["category,region,average_value,count"]
    for row in summary:
        lines.append(f"{row['category']},{row['region']},{row['average_value']},{row['count']}")
    return "\n".join(lines)
