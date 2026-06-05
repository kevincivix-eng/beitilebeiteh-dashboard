# דשבורד "מביתי לביתך" · من بيتي لبيتك

דשבורד מעקב להעברת פריטים יד-שנייה בין משפחות בנגב המזרחי, מבוסס על נתוני Airtable חיים ועל שפת המותג החדשה של הארגון.

## תצוגות
1. **דף הבית** — מפת זרימת מסירות (Leaflet) + מדדי על (KPIs)
2. **תנועות במרחב** — תרשים Sankey מוצא→יעד + פילוח תוך/בין-יישובי
3. **ניתוח חפצים** — כמות לפי קטגוריה + החפצים המובילים
4. **משתתפים בזמן** — מצטרפים חדשים מול חברים מצטבר
5. **חפצים בזמן** — פריטים שנמסרו לפי שבוע וקטגוריה
6. **ניתוח משקלים** — חיסכון בפסולת מוטמנת לפי קטגוריה ועיר מוצא

## ארכיטקטורה
- Frontend: Vanilla HTML/CSS/JS + Leaflet, Chart.js, d3-sankey (CDN). RTL, עברית.
- נתונים: `build/fetch_data.js` שולף מ-Airtable ומאגרג ל-`data/*.json` בזמן build.
- פרסום: GitHub Pages דרך GitHub Actions (`.github/workflows/deploy.yml`), רענון יומי.

## הרצה מקומית
```bash
# 1. שליפת נתונים (דורש טוקן Airtable)
AIRTABLE_API_KEY=pat... node build/fetch_data.js

# 2. שרת מקומי
node .claude/serve.js   # או: python3 -m http.server 8766
# פתח http://localhost:8766
```

## הגדרת פרסום
1. ב-GitHub: **Settings → Secrets and variables → Actions** → הוסף `AIRTABLE_API_KEY`.
2. **Settings → Pages → Source: GitHub Actions**.
3. כל push ל-`main` (וכן ריצה יומית) יבנה ויפרסם אוטומטית.

## נתונים
- מקור ראשי: Airtable base `appOPXerkRuO4YH1D` (טבלאות EVENT, חפצים מועברים, רשימת חפצים, מסירות שלא הושלמו).
- `data/members.json` — נתוני חברות לאורך זמן, מיוצא מקובץ ה-Excel של הארגון (עדכון ידני).

> הטוקן של Airtable **אינו** נשמר ב-repo — רק כ-Secret ב-GitHub וב-`config.js` מקומי (gitignored).
