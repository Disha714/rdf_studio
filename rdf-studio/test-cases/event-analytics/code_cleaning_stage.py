def cleaning_stage(events):
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
