def outlier_detection(events):
    parsed = []
    for row in events:
        try:
            value = float(row.get("value"))
        except (TypeError, ValueError):
            continue
        parsed.append((row, value))
    if not parsed:
        return []

    values = [v for _, v in parsed]
    mean = sum(values) / len(values)
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    std_dev = variance ** 0.5
    threshold = 3.0

    flagged = []
    for row, value in parsed:
        z_score = (value - mean) / std_dev if std_dev > 0 else 0.0
        out = dict(row)
        out["value"] = value
        out["is_outlier"] = abs(z_score) > threshold
        flagged.append(out)
    return flagged
