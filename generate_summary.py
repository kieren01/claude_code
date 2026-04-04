import os
import csv
import io
import glob
import requests
from datetime import datetime, timedelta, timezone

TELEGRAM_BOT_TOKEN = os.environ['TELEGRAM_BOT_TOKEN']
TELEGRAM_CHAT_ID = os.environ['TELEGRAM_CHAT_ID']
GEMINI_API_KEY = os.environ['GEMINI_API_KEY']
SHEET_ID = os.environ['SHEET_ID']

SGT = timezone(timedelta(hours=8))


def send_telegram(message):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    requests.post(url, data={'chat_id': TELEGRAM_CHAT_ID, 'text': message})


def get_sheet_data():
    url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv"
    resp = requests.get(url)
    resp.raise_for_status()
    return list(csv.DictReader(io.StringIO(resp.text)))


def parse_timestamp(ts_str):
    formats = [
        '%m/%d/%Y %H:%M:%S',
        '%d/%m/%Y %H:%M:%S',
        '%Y-%m-%d %H:%M:%S',
        '%m/%d/%Y %I:%M:%S %p',
        '%d/%m/%Y %I:%M:%S %p',
    ]
    for fmt in formats:
        try:
            return datetime.strptime(ts_str.strip(), fmt).replace(tzinfo=SGT)
        except ValueError:
            continue
    return None


def get_week_responses(rows):
    now_sgt = datetime.now(SGT)
    monday_sgt = (now_sgt - timedelta(days=now_sgt.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    timestamp_key = list(rows[0].keys())[0] if rows else 'Timestamp'
    return [
        row for row in rows
        if (ts := parse_timestamp(row.get(timestamp_key, ''))) and monday_sgt <= ts <= now_sgt
    ]


def call_gemini(prompt):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_API_KEY}"
    resp = requests.post(url, json={"contents": [{"parts": [{"text": prompt}]}]})
    resp.raise_for_status()
    return resp.json()['candidates'][0]['content']['parts'][0]['text']


def generate_weekly_summary(responses):
    if not responses:
        return "No responses found for this week."
    text = "\n\n".join(
        "\n".join(f"{k}: {v}" for k, v in row.items())
        for row in responses
    )
    return call_gemini(f"""These are my weekly reflection form responses (Monday to Sunday this week):

{text}

Write a concise, warm, easy-to-read 1-minute summary of my week. Cover:
- Key themes and patterns across my responses
- Notable highs, lows, or turning points
- Overall mood and energy through the week
Be personal and insightful, not generic.""")


def generate_trend_analysis(summaries_dict, weeks):
    text = "\n\n---\n\n".join(
        f"Week of {date}:\n{summary}"
        for date, summary in sorted(summaries_dict.items())
    )
    label = {2: "2-week", 4: "4-week", 8: "2-month"}[weeks]
    return call_gemini(f"""Here are my weekly reflection summaries from the past {label} period:

{text}

Identify high-level trends across these weeks:
- Recurring themes or patterns
- Changes in mood, energy, or focus over time
- What seems to be improving or declining
- Any notable shifts
Keep it concise, honest, and actionable.""")


def save_summary(summary, date_str):
    os.makedirs('summaries', exist_ok=True)
    with open(f'summaries/{date_str}.txt', 'w') as f:
        f.write(summary)


def load_summaries(files):
    result = {}
    for f in files:
        date = os.path.basename(f).replace('.txt', '')
        with open(f) as fp:
            result[date] = fp.read()
    return result


def main():
    now_sgt = datetime.now(SGT)
    date_str = now_sgt.strftime('%Y-%m-%d')

    rows = get_sheet_data()
    week_responses = get_week_responses(rows)

    summary = generate_weekly_summary(week_responses)
    save_summary(summary, date_str)

    send_telegram(f"Weekly Reflection Summary — {date_str}\n\n{summary}")

    all_files = sorted(glob.glob('summaries/*.txt'))
    count = len(all_files)

    if count >= 8 and count % 8 == 0:
        trend = generate_trend_analysis(load_summaries(all_files[-8:]), 8)
        send_telegram(f"2-Month Trend Analysis\n\n{trend}")
    elif count >= 4 and count % 4 == 0:
        trend = generate_trend_analysis(load_summaries(all_files[-4:]), 4)
        send_telegram(f"4-Week Trend Analysis\n\n{trend}")
    elif count >= 2 and count % 2 == 0:
        trend = generate_trend_analysis(load_summaries(all_files[-2:]), 2)
        send_telegram(f"2-Week Trend Analysis\n\n{trend}")


if __name__ == '__main__':
    main()
