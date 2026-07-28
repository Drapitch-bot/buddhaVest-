# טופס Data Safety — תשובות מדויקות

**Play Console → App content → Data safety → Start**

כל תשובה כאן נגזרה מקריאה בקוד, לא מהערכה. מקור כל קביעה מצוין בסוגריים.

---

## שלב 1 — Data collection and security

| שאלה | תשובה | למה |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | סמלי מניות ומזהה התקנה יוצאים מהמכשיר |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | כל שישה יעדי הרשת הם `https://` ללא יוצא מן הכלל |
| Do you provide a way for users to request that their data is deleted? | **Yes** | "איפוס הכל" ב־More מוחק את כל האחסון המקומי; בשרת לא נשמר כלום |

**יעדי הרשת שנמצאו בקוד** — `buddhavest.onrender.com`, `query1/query2.finance.yahoo.com`, `stooq.com`, `seekingalpha.com`, `translate.googleapis.com`. כולם HTTPS.

---

## שלב 2 — אילו סוגי נתונים לסמן

### ✅ לסמן — App activity

| תת־קטגוריה | Collected | Shared | Ephemeral | Required/Optional | Purpose |
|---|---|---|---|---|---|
| **App interactions** | Yes | No | **No** | Required | App functionality |
| **In-app search history** | Yes | No | **No** | Required | App functionality |
| **Other user-generated content** | Yes | No | **No** | Required | App functionality |

**מה זה בפועל:**

- **In-app search history** — מה שהקלדת בחיפוש נשלח כ־`/search?q=...` (`constants/api.js`)
- **App interactions** — כל מניה שנפתחת נשלחת כ־`/analyze/<ticker>` (`StockScreen.js:253`)
- **Other user-generated content** — רשימת המעקב. היא *נשמרת* רק במכשיר, אבל כדי להציג מחיר וציון לכל שורה הסמלים נשלחים לשרת: `watchlist.map(w => w.ticker).join(',')` (`BrandHeader.js:58`, `WatchlistScreen.js:159`)

**למה Ephemeral = No:** ספק האחסון (Render) שומר לוגי גישה שכוללים את כתובת ה־URL, ובה מופיע הסמל. זה חורג מ"עיבוד בזיכרון בלבד". עדיף להצהיר מאשר להסתמך על פטור שנוי במחלוקת.

### ✅ לסמן — Device or other IDs

| Collected | Shared | Ephemeral | Required/Optional | Purpose |
|---|---|---|---|---|
| Yes | No | No | Required | App functionality |

`expo-updates` מייצר **מזהה התקנה אקראי** ושולח אותו לשרתי Expo כדי לדעת אילו מכשירים כבר קיבלו עדכון. זה לא מזהה אישי ולא מזהה פרסומי, אבל הוא כן מזהה מכשיר — וגוגל דורשת להצהיר עליו.

*Shared = No* כי Expo היא ספק שירות שמעבד בשמך, וגוגל מחריגה העברה לספק שירות מהגדרת "שיתוף".

---

## ❌ מה לא לסמן — ולמה

| קטגוריה | למה לא |
|---|---|
| Personal info (שם, אימייל, טלפון, מזהי ממשלה) | אין רישום, אין חשבון, אין שדה קלט כזה בשום מסך |
| Financial info | **שים לב:** יומן המחקר יכול להכיל טקסט חופשי על עסקאות — אבל הוא **אף פעם לא עוזב את המכשיר**. אומת: `buddhavest_journal` מופיע רק ב־`getItem`/`setItem`/`removeItem`, אף פעם לא ב־`fetch` |
| Location | אין הרשאת מיקום, ואין שימוש בכתובת IP להסקת מיקום |
| Contacts · Photos · Audio · Files · Calendar · Messages · Health | אין הרשאות כאלה. המניפסט מכיל **רק** `INTERNET` ו־`ACCESS_NETWORK_STATE` |
| Crash logs · Diagnostics | אין Sentry, Crashlytics, Bugsnag או כל SDK דומה. נסרקו כל 19 התלויות ב־`package.json` |
| Advertising ID | אין SDK פרסומי בכלל |

---

## ⚠️ החלטה אחת שצריכה את שיקול דעתך

**קישורי הכתבות.** כשתרגום בתוך האפליקציה מופעל, כתובת הכתבה נשלחת לשרת שלנו כדי להביא ולתרגם את הטקסט (`ArticleScreen.js:166`).

ההגדרה של גוגל ל־**Web browsing history** היא "מידע על אתרים שהמשתמש ביקר בהם" — וזה מתאים מילולית.

**ההמלצה שלי: לסמן.** Collected=Yes · Shared=No · Ephemeral=No · Required=Optional · Purpose=App functionality.

**למה בכל זאת יש כאן ספק:** המשתמש לא גולש בחופשיות — הוא פותח כתבות שהאפליקציה עצמה הציגה לו, וזו יותר אינטראקציה בתוך האפליקציה מאשר היסטוריית גלישה. אפליקציות חדשות רבות לא מצהירות על זה.

**למה אני בכל זאת ממליץ לסמן:** הצהרת יתר לא נענשת. הצהרת חסר היא עילה להסרה. Optional (ולא Required) מדויק כאן, כי התרגום ניתן לכיבוי בהגדרות.

---

## אחרי המילוי

1. **Save** בכל מסך, ואז **Submit** במסך הסיכום
2. הקישור למדיניות הפרטיות: `https://buddhavest.onrender.com/privacy`
3. גוגל משווה בין הטופס למדיניות. שני המסמכים חייבים לומר אותו דבר.

---

## תיקון שנעשה תוך כדי הכנת הטופס

מדיניות הפרטיות הכילה **קביעה שגויה**:

> "The following data is stored locally on your device only and is never transmitted to our servers: **Your watchlist**…"

הקוד סותר את זה. `BrandHeader.js:58` ו־`WatchlistScreen.js:159` שולחים את סמלי רשימת המעקב ל־`/quotes`, ו־`WatchlistScreen.js:185` שולח כל סמל ל־`/analyze`.

**התיקון מבדיל בין "נשמר" לבין "נשלח":** הרשימה נשמרת רק במכשיר ולא נכתבת לשום מסד נתונים בשרת — אבל הסמלים כן נשלחים בכל בקשה, כי אחרת אי אפשר להציג מחיר. היומן, לעומת זאת, באמת לא עוזב את המכשיר, וזה נאמר עכשיו במפורש. נוסף גם סעיף על קישורי הכתבות, שלא הוזכר קודם כלל.

זה חשוב כי טופס Data Safety שסותר את מדיניות הפרטיות הוא הפרת מדיניות בפני עצמה.
