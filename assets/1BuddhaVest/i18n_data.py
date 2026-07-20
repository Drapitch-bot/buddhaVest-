"""
Copyright (c) 2026, the creator of this application. All rights reserved.
Part of the BuddhaVest personal stock-research application.
Unauthorized copying, distribution, or use of this code, in whole or in part,
without explicit written permission from the copyright holder is prohibited.
"""

"""
i18n_data.py
מילון תרגומים להסברי המדדים (analyzer.py) ולתגי "דברים שכדאי לעקוב אחריהם" (news_signals.py).
כל מפתח מכיל תבנית בעברית/אנגלית/רוסית/ספרדית, עם placeholders בסגנון {name} שמוחלפים ב-main.py.

חשוב: שמות המדדים עצמם (P/E Ratio, Market Cap וכו') נשארים תמיד באנגלית - זה כבר מוגדר
ב-analyzer.py כ-"label" ולא מתורגם. כאן מתורגמים רק ה"הסברים" (sentences).
"""

EXPLANATIONS = {
    # ---------- המלצה + סיכומי דיבידנד/רכישה חוזרת (מתורגמים לפי lang) ----------
    "rec_insufficient": {
        "he": "לא נמצא מספיק מידע פיננסי כדי לנקד את החברה הזו.",
        "en": "Not enough financial data was found to score this company.",
        "ru": "Недостаточно финансовых данных для оценки этой компании.",
        "es": "No se encontraron suficientes datos financieros para puntuar esta empresa.",
    },
    "rec_buy": {
        "he": "פונדמנטלס חזקים ומחיר סביר - החברה הזו עומדת ברוב הקריטריונים.",
        "en": "Strong fundamentals at a reasonable price - this company meets most of the criteria.",
        "ru": "Сильные фундаментальные показатели по разумной цене - компания соответствует большинству критериев.",
        "es": "Fundamentos sólidos a un precio razonable - esta empresa cumple la mayoría de los criterios.",
    },
    "rec_hold": {
        "he": "עסק לא רע, אבל התזמון או המחיר עדיין לא אידיאליים.",
        "en": "Not a bad business, but the timing or price isn't ideal yet.",
        "ru": "Неплохой бизнес, но время или цена пока не идеальны.",
        "es": "No es un mal negocio, pero el momento o el precio aún no son ideales.",
    },
    "rec_avoid": {
        "he": "כמה דגלים אדומים - זה לא עומד בסטנדרט כרגע.",
        "en": "Several red flags - it doesn't meet the standard right now.",
        "ru": "Несколько тревожных сигналов - сейчас не соответствует стандарту.",
        "es": "Varias señales de alerta - por ahora no cumple el estándar.",
    },
    "div_pays": {
        "he": "מחלקת דיבידנד (תשואה של כ-{pct}%).",
        "en": "Pays a dividend (yield of about {pct}%).",
        "ru": "Выплачивает дивиденды (доходность около {pct}%).",
        "es": "Reparte dividendo (rentabilidad de aproximadamente {pct}%).",
    },
    "div_none": {
        "he": "לא מחלקת דיבידנד.",
        "en": "Does not pay a dividend.",
        "ru": "Не выплачивает дивиденды.",
        "es": "No reparte dividendo.",
    },
    "bb_with_pct": {
        "he": "רוכשת בחזרה מניות (כ-{pct}% משווי השוק בשנה האחרונה).",
        "en": "Buys back shares (about {pct}% of market cap in the past year).",
        "ru": "Выкупает акции (около {pct}% рыночной капитализации за последний год).",
        "es": "Recompra acciones (alrededor del {pct}% de la capitalización en el último año).",
    },
    "bb_plain": {
        "he": "רוכשת בחזרה מניות.",
        "en": "Buys back shares.",
        "ru": "Выкупает акции.",
        "es": "Recompra acciones.",
    },
    "bb_none": {
        "he": "לא רוכשת בחזרה מניות.",
        "en": "Does not buy back shares.",
        "ru": "Не выкупает акции.",
        "es": "No recompra acciones.",
    },
    # ---------- הודעות "אין מספיק מידע" משותפות ----------
    "metric_no_data": {
        "he": "אין מספיק נתונים.",
        "en": "Not enough data.",
        "ru": "Недостаточно данных.",
        "es": "No hay suficientes datos.",
    },
    "balance_no_data": {
        "he": "אין מספיק נתוני מאזן.",
        "en": "Not enough balance sheet data.",
        "ru": "Недостаточно данных баланса.",
        "es": "No hay suficientes datos del balance.",
    },
    "stooq_partial_note": {
        "he": "Yahoo Finance לא מחזיק נתונים פונדמנטליים על המנייה הזו (לעיתים קורה במניות לא-אמריקאיות/לא-נזילות). הצלחנו למשוך לפחות מחיר עדכני ממקור גיבוי (Stooq), אבל אי אפשר להפיק ציון BuddhaVest מלא בלי דוחות כספיים.",
        "en": "Yahoo Finance has no fundamental data for this stock (common for non-U.S. or illiquid stocks). We pulled at least a current price from a backup source (Stooq), but a full BuddhaVest score isn't possible without financial statements.",
        "ru": "У Yahoo Finance нет фундаментальных данных по этой акции (часто бывает для неамериканских или неликвидных акций). Мы получили хотя бы текущую цену из резервного источника (Stooq), но полную оценку BuddhaVest без финансовой отчётности составить нельзя.",
        "es": "Yahoo Finance no tiene datos fundamentales de esta acción (común en acciones no estadounidenses o poco líquidas). Obtuvimos al menos un precio actual de una fuente de respaldo (Stooq), pero no es posible calcular una puntuación BuddhaVest completa sin los estados financieros.",
    },

    # ---------- Current Ratio ----------
    "cr_strong": {
        "he": "נזילות חזקה - יש מרווח נוח לכיסוי התחייבויות קצרות טווח.",
        "en": "Strong liquidity - a comfortable cushion to cover short-term obligations.",
        "ru": "Высокая ликвидность - достаточный запас для покрытия краткосрочных обязательств.",
        "es": "Liquidez sólida - un margen cómodo para cubrir obligaciones a corto plazo.",
    },
    "cr_healthy": {
        "he": "בריא - הנכסים השוטפים מכסים את ההתחייבויות השוטפות.",
        "en": "Healthy - current assets cover current liabilities.",
        "ru": "Хорошо - текущие активы покрывают текущие обязательства.",
        "es": "Saludable - los activos corrientes cubren los pasivos corrientes.",
    },
    "cr_tight_ok": {
        "he": "קצת צמוד, אבל נפוץ בעסקים שלא דורשים הרבה נכסים.",
        "en": "A bit tight, but common for asset-light businesses.",
        "ru": "Немного напряжённо, но обычно для бизнеса с малым объёмом активов.",
        "es": "Algo ajustado, pero común en negocios con pocos activos.",
    },
    "cr_tight": {
        "he": "נזילות צמודה - שווה לעקוב.",
        "en": "Tight liquidity - worth keeping an eye on.",
        "ru": "Низкая ликвидность - стоит следить за ситуацией.",
        "es": "Liquidez ajustada - vale la pena vigilarlo.",
    },

    # ---------- Debt / Equity ----------
    "d2e_not_reported": {
        "he": "לא דווח.",
        "en": "Not reported.",
        "ru": "Не указано.",
        "es": "No reportado.",
    },
    "d2e_low": {
        "he": "מינוף נמוך - מאזן שמרני.",
        "en": "Low leverage - a conservative balance sheet.",
        "ru": "Низкая долговая нагрузка - консервативный баланс.",
        "es": "Apalancamiento bajo - un balance conservador.",
    },
    "d2e_negative_equity": {
        "he": "הון עצמי שלילי - ההתחייבויות גבוהות מהנכסים. דגל אדום משמעותי במאזן.",
        "en": "Negative equity - liabilities exceed assets. A significant red flag on the balance sheet.",
        "ru": "Отрицательный капитал - обязательства превышают активы. Серьёзный тревожный сигнал в балансе.",
        "es": "Patrimonio neto negativo - los pasivos superan a los activos. Una señal de alerta importante en el balance.",
    },
    "d2e_moderate": {
        "he": "מינוף סביר - נורמלי לחברות גדולות רבות.",
        "en": "Reasonable leverage - normal for many large companies.",
        "ru": "Умеренная долговая нагрузка - норма для многих крупных компаний.",
        "es": "Apalancamiento razonable - normal en muchas grandes empresas.",
    },
    "d2e_high": {
        "he": "מינוף גבוה - נטל החוב משמעותי.",
        "en": "High leverage - the debt burden is significant.",
        "ru": "Высокая долговая нагрузка - значительное долговое бремя.",
        "es": "Apalancamiento alto - la carga de deuda es significativa.",
    },
    "d2e_very_high": {
        "he": "מינוף גבוה מאוד - החוב כבד יחסית להון העצמי.",
        "en": "Very high leverage - debt is heavy relative to equity.",
        "ru": "Очень высокая долговая нагрузка - долг значителен относительно капитала.",
        "es": "Apalancamiento muy alto - la deuda es elevada respecto al capital.",
    },

    # ---------- Operating Margin ----------
    "opm_excellent": {
        "he": "יעילות תפעולית מצוינת וכוח תמחור גבוה.",
        "en": "Excellent operating efficiency and strong pricing power.",
        "ru": "Отличная операционная эффективность и сильная ценовая власть.",
        "es": "Excelente eficiencia operativa y fuerte poder de fijación de precios.",
    },
    "opm_solid": {
        "he": "שולי תפעול סבירים, מעל סף ה-10%.",
        "en": "Solid operating margin, above the 10% mark.",
        "ru": "Хорошая операционная маржа, выше отметки 10%.",
        "es": "Margen operativo sólido, por encima del 10%.",
    },
    "opm_thin": {
        "he": "שולי רווח דחוקים - העסק פועל קרוב לאיזון תפעולי.",
        "en": "Thin margins - the business operates close to break-even.",
        "ru": "Низкая маржа - бизнес работает близко к точке безубыточности.",
        "es": "Márgenes ajustados - el negocio opera cerca del punto de equilibrio.",
    },
    "opm_loss": {
        "he": "הפסדים תפעוליים - העסק הליבה שורף מזומן.",
        "en": "Operating losses - the core business is burning cash.",
        "ru": "Операционные убытки - основной бизнес теряет денежные средства.",
        "es": "Pérdidas operativas - el negocio principal consume efectivo.",
    },

    # ---------- Gross Margin ----------
    "gm_high": {
        "he": "שולי רווח גולמי גבוהים - סימן ליתרון תחרותי וכוח תמחור.",
        "en": "High gross margin - a sign of competitive advantage and pricing power.",
        "ru": "Высокая валовая маржа - признак конкурентного преимущества и ценовой власти.",
        "es": "Margen bruto alto - señal de ventaja competitiva y poder de fijación de precios.",
    },
    "gm_ok": {
        "he": "שולי רווח גולמי סבירים.",
        "en": "Reasonable gross margin.",
        "ru": "Приемлемая валовая маржа.",
        "es": "Margen bruto razonable.",
    },
    "gm_low": {
        "he": "שולי רווח גולמי נמוכים - מתאים לעסקים מבוססי נפח.",
        "en": "Low gross margin - typical of volume-based businesses.",
        "ru": "Низкая валовая маржа - типично для бизнеса, ориентированного на объём.",
        "es": "Margen bruto bajo - típico de negocios basados en volumen.",
    },
    "gm_negative": {
        "he": "שולי רווח גולמי שליליים - עלות המכר גבוהה מההכנסות.",
        "en": "Negative gross margin - cost of revenue exceeds revenue.",
        "ru": "Отрицательная валовая маржа - себестоимость превышает выручку.",
        "es": "Margen bruto negativo - el costo de ventas supera los ingresos.",
    },

    # ---------- Net Margin ----------
    "nm_high": {
        "he": "שולי רווח נקי גבוהים - העסק שומר חלק גדול מההכנסות כרווח.",
        "en": "High net margin - the business keeps a large share of revenue as profit.",
        "ru": "Высокая чистая маржа - бизнес сохраняет значительную часть выручки как прибыль.",
        "es": "Margen neto alto - el negocio conserva una gran parte de los ingresos como beneficio.",
    },
    "nm_ok": {
        "he": "שולי רווח נקי סבירים.",
        "en": "Reasonable net margin.",
        "ru": "Приемлемая чистая маржа.",
        "es": "Margen neto razonable.",
    },
    "nm_thin": {
        "he": "שולי רווח נקי דחוקים.",
        "en": "Thin net margin.",
        "ru": "Низкая чистая маржа.",
        "es": "Margen neto ajustado.",
    },
    "nm_negative": {
        "he": "שולי רווח נקי שליליים - העסק מפסיד כסף בשורה התחתונה.",
        "en": "Negative net margin - the business loses money at the bottom line.",
        "ru": "Отрицательная чистая маржа - бизнес работает в убыток.",
        "es": "Margen neto negativo - el negocio pierde dinero en el resultado final.",
    },

    # ---------- Cost of Revenue ----------
    "cor_base": {
        "he": "עלות המכר - הסכום שהחברה משקיעה בייצור/רכישת המוצרים שמכרה.",
        "en": "Cost of revenue - the amount the company spends producing/acquiring what it sold.",
        "ru": "Себестоимость продаж - сумма, которую компания тратит на производство/приобретение проданного.",
        "es": "Costo de ventas - lo que la empresa gasta en producir/adquirir lo que vendió.",
    },
    "cor_pct": {
        "he": "מהווה כ-{pct}% מההכנסות.",
        "en": "About {pct}% of revenue.",
        "ru": "Около {pct}% от выручки.",
        "es": "Aproximadamente el {pct}% de los ingresos.",
    },

    # ---------- Operating Cash Flow ----------
    "ocf_positive": {
        "he": "תזרים חיובי מהפעילות השוטפת - העסק עצמו (בלי השקעות) מייצר מזומן.",
        "en": "Positive operating cash flow - the core business (excluding investments) generates cash.",
        "ru": "Положительный операционный денежный поток - основной бизнес (без инвестиций) генерирует деньги.",
        "es": "Flujo de caja operativo positivo - el negocio principal (sin inversiones) genera efectivo.",
    },
    "ocf_negative": {
        "he": "תזרים שלילי מהפעילות השוטפת - העסק עצמו צורך מזומן.",
        "en": "Negative operating cash flow - the core business consumes cash.",
        "ru": "Отрицательный операционный денежный поток - основной бизнес потребляет деньги.",
        "es": "Flujo de caja operativo negativo - el negocio principal consume efectivo.",
    },

    # ---------- Cash Position ----------
    "cash_pos_base": {
        "he": 'סך המזומנים והשווי מזומן שבידי החברה - "כריות הביטחון" שלה למצבי חירום או הזדמנויות.',
        "en": 'Total cash and cash equivalents held by the company - its "safety cushion" for emergencies or opportunities.',
        "ru": 'Общая сумма денежных средств и их эквивалентов - "финансовая подушка" компании для чрезвычайных ситуаций или возможностей.',
        "es": 'Efectivo total y equivalentes de efectivo de la empresa - su "colchón de seguridad" para emergencias u oportunidades.',
    },
    "cash_pos_covers": {
        "he": "זה מכסה חלק נכבד מההתחייבויות הכוללות - מצב נוח.",
        "en": "This covers a significant share of total liabilities - a comfortable position.",
        "ru": "Это покрывает значительную часть общих обязательств - комфортная позиция.",
        "es": "Esto cubre una parte significativa del pasivo total - una posición cómoda.",
    },
    "cash_pos_low": {
        "he": "זה נמוך יחסית להתחייבויות הכוללות.",
        "en": "This is low relative to total liabilities.",
        "ru": "Это немного по сравнению с общими обязательствами.",
        "es": "Esto es bajo en relación con el pasivo total.",
    },

    # ---------- Liabilities / Equity ----------
    "l2e_conservative": {
        "he": "ההתחייבויות הכוללות נמוכות מההון העצמי - מאזן שמרני (יחס מתחת ל-1).",
        "en": "Total liabilities are lower than equity - a conservative balance sheet (ratio below 1).",
        "ru": "Общие обязательства ниже собственного капитала - консервативный баланс (соотношение менее 1).",
        "es": "El pasivo total es menor que el patrimonio - un balance conservador (ratio menor a 1).",
    },
    "l2e_negative_equity": {
        "he": "הון עצמי שלילי - ההתחייבויות גבוהות מהנכסים. דגל אדום משמעותי במאזן.",
        "en": "Negative equity - liabilities exceed assets. A significant red flag on the balance sheet.",
        "ru": "Отрицательный капитал - обязательства превышают активы. Серьёзный тревожный сигнал в балансе.",
        "es": "Patrimonio neto negativo - los pasivos superan a los activos. Una señal de alerta importante en el balance.",
    },
    "l2e_elevated": {
        "he": "ההתחייבויות הכוללות גבוהות מההון העצמי אך בטווח סביר.",
        "en": "Total liabilities exceed equity, but within a reasonable range.",
        "ru": "Общие обязательства превышают собственный капитал, но в разумных пределах.",
        "es": "El pasivo total supera al patrimonio, pero dentro de un rango razonable.",
    },
    "l2e_high": {
        "he": "ההתחייבויות הכוללות גבוהות משמעותית מההון העצמי - מאזן ממונף.",
        "en": "Total liabilities significantly exceed equity - a leveraged balance sheet.",
        "ru": "Общие обязательства значительно превышают собственный капитал - баланс с высокой долговой нагрузкой.",
        "es": "El pasivo total supera significativamente al patrimonio - un balance apalancado.",
    },

    # ---------- Net Income Trend ----------
    "nit_no_history": {
        "he": "אין מספיק היסטוריה.",
        "en": "Not enough history.",
        "ru": "Недостаточно истории.",
        "es": "No hay suficiente historial.",
    },
    "nit_growing": {
        "he": "הרווחים חיוביים וצומחים משנה לשנה.",
        "en": "Profits are positive and growing year over year.",
        "ru": "Прибыль положительная и растёт из года в год.",
        "es": "Las ganancias son positivas y crecen año tras año.",
    },
    "nit_profit_declining": {
        "he": "רווחי, אבל הרווח ירד בהשוואה לשנה שעברה.",
        "en": "Profitable, but profit declined compared to last year.",
        "ru": "Прибыльна, но прибыль снизилась по сравнению с прошлым годом.",
        "es": "Rentable, pero el beneficio disminuyó respecto al año anterior.",
    },
    "nit_losses_shrinking": {
        "he": "עדיין לא רווחי, אבל ההפסדים מצטמצמים.",
        "en": "Still not profitable, but losses are shrinking.",
        "ru": "Пока не прибыльна, но убытки сокращаются.",
        "es": "Aún no es rentable, pero las pérdidas se están reduciendo.",
    },
    "nit_losses_growing": {
        "he": "לא רווחי וההפסדים מתרחבים.",
        "en": "Not profitable, and losses are widening.",
        "ru": "Не прибыльна, и убытки увеличиваются.",
        "es": "No es rentable, y las pérdidas están aumentando.",
    },

    # ---------- P/E Ratio ----------
    "pe_not_profitable": {
        "he": "אין מכפיל רווח - החברה עדיין לא רווחית.",
        "en": "No P/E ratio - the company isn't profitable yet.",
        "ru": "Нет коэффициента P/E - компания пока не прибыльна.",
        "es": "Sin ratio P/E - la empresa aún no es rentable.",
    },
    "pe_cheap": {
        "he": "זול יחסית לרווחים.",
        "en": "Cheap relative to earnings.",
        "ru": "Дешево относительно прибыли.",
        "es": "Barata en relación con las ganancias.",
    },
    "pe_reasonable": {
        "he": "תמחור סביר.",
        "en": "Reasonable valuation.",
        "ru": "Разумная оценка.",
        "es": "Valoración razonable.",
    },
    "pe_expensive_growth": {
        "he": "בצד היקר - השוק מצפה לצמיחה חזקה.",
        "en": "On the expensive side - the market expects strong growth.",
        "ru": "Дороговато - рынок ожидает сильного роста.",
        "es": "Del lado caro - el mercado espera un fuerte crecimiento.",
    },
    "pe_expensive": {
        "he": "יקר - הרבה צמיחה עתידית כבר מתומחרת במחיר.",
        "en": "Expensive - a lot of future growth is already priced in.",
        "ru": "Дорого - значительный будущий рост уже заложен в цену.",
        "es": "Cara - mucho del crecimiento futuro ya está incluido en el precio.",
    },

    # ---------- PEG Ratio ----------
    "peg_no_growth_data": {
        "he": "אין מספיק נתוני צמיחה לחישוב.",
        "en": "Not enough growth data to calculate.",
        "ru": "Недостаточно данных о росте для расчёта.",
        "es": "No hay suficientes datos de crecimiento para calcularlo.",
    },
    "peg_fair": {
        "he": "הצמיחה מצדיקה את המחיר - סימן קלאסי לתמחור הוגן.",
        "en": "Growth justifies the price - a classic sign of fair valuation.",
        "ru": "Рост оправдывает цену - классический признак справедливой оценки.",
        "es": "El crecimiento justifica el precio - una señal clásica de valoración justa.",
    },
    "peg_ahead": {
        "he": "המחיר רץ קצת לפני הצמיחה.",
        "en": "The price is running a bit ahead of growth.",
        "ru": "Цена немного опережает рост.",
        "es": "El precio va un poco por delante del crecimiento.",
    },
    "peg_well_ahead": {
        "he": "המחיר רץ הרבה לפני הצמיחה - יקר יחסית למה שמקבלים.",
        "en": "The price is running well ahead of growth - expensive relative to what you get.",
        "ru": "Цена значительно опережает рост - дорого по сравнению с тем, что вы получаете.",
        "es": "El precio va muy por delante del crecimiento - caro en relación con lo que se obtiene.",
    },

    # ---------- Free Cash Flow ----------
    "fcf_positive": {
        "he": "תזרים מזומנים חופשי חיובי - העסק מייצר מזומן פנוי אמיתי.",
        "en": "Positive free cash flow - the business generates real spare cash.",
        "ru": "Положительный свободный денежный поток - бизнес генерирует реальные свободные средства.",
        "es": "Flujo de caja libre positivo - el negocio genera efectivo real disponible.",
    },
    "fcf_negative": {
        "he": "תזרים מזומנים חופשי שלילי - העסק שורף מזומן.",
        "en": "Negative free cash flow - the business is burning cash.",
        "ru": "Отрицательный свободный денежный поток - бизнес теряет денежные средства.",
        "es": "Flujo de caja libre negativo - el negocio está consumiendo efectivo.",
    },

    # ---------- Cash Runway ----------
    "runway_not_applicable": {
        "he": "לא רלוונטי - החברה לא שורפת מזומן.",
        "en": "Not applicable - the company isn't burning cash.",
        "ru": "Неприменимо - компания не теряет денежные средства.",
        "es": "No aplica - la empresa no está consumiendo efectivo.",
    },
    "runway_years": {
        "he": 'כ-{years} שנות "מסלול" בקצב השריפה הנוכחי - מצב נוח.',
        "en": 'About {years} years of "runway" at the current burn rate - a comfortable position.',
        "ru": 'Около {years} лет "запаса" при текущем темпе расходования - комфортная позиция.',
        "es": 'Cerca de {years} años de "margen" al ritmo actual de consumo - una posición cómoda.',
    },
    "runway_months_manageable": {
        "he": 'כ-{months} חודשי "מסלול" - בר ניהול אך שווה לעקוב.',
        "en": 'About {months} months of "runway" - manageable but worth watching.',
        "ru": 'Около {months} месяцев "запаса" - управляемо, но стоит следить.',
        "es": 'Cerca de {months} meses de "margen" - manejable pero vale la pena vigilarlo.',
    },
    "runway_months_risky": {
        "he": 'כ-{months} חודשי "מסלול" - ייתכן שיהיה צורך בגיוס הון נוסף בקרוב.',
        "en": 'About {months} months of "runway" - additional fundraising may be needed soon.',
        "ru": 'Около {months} месяцев "запаса" - возможно, скоро потребуется дополнительное привлечение капитала.',
        "es": 'Cerca de {months} meses de "margen" - podría necesitarse más financiación pronto.',
    },

    # ---------- Dividend (metric-level) ----------
    "div_metric_none": {
        "he": "החברה לא מחלקת דיבידנד - כל הרווחים מושקעים מחדש או נשארים כמזומן.",
        "en": "The company doesn't pay a dividend - all profits are reinvested or kept as cash.",
        "ru": "Компания не платит дивиденды - вся прибыль реинвестируется или остаётся в виде денежных средств.",
        "es": "La empresa no paga dividendos - todas las ganancias se reinvierten o se mantienen como efectivo.",
    },
    "div_yield": {
        "he": "תשואה של {pct}%.",
        "en": "Yield of {pct}%.",
        "ru": "Доходность {pct}%.",
        "es": "Rendimiento del {pct}%.",
    },
    "div_yield_unknown": {
        "he": "החברה משלמת דיבידנד (לפי היסטוריית תשלומים), אך לא ניתן לחשב תשואה מדויקת כרגע.",
        "en": "The company pays a dividend (based on payment history), but an exact yield can't be calculated right now.",
        "ru": "Компания платит дивиденды (согласно истории выплат), но точную доходность сейчас рассчитать нельзя.",
        "es": "La empresa paga dividendos (según el historial de pagos), pero no se puede calcular un rendimiento exacto en este momento.",
    },
    "div_consistent": {
        "he": "משולם בעקביות כ-{years} שנים - סימן לתזרים מזומנים יציב.",
        "en": "Paid consistently for about {years} years - a sign of stable cash flow.",
        "ru": "Стабильно выплачивается около {years} лет - признак устойчивого денежного потока.",
        "es": "Se paga de forma constante desde hace {years} años - señal de un flujo de caja estable.",
    },
    "div_building": {
        "he": "ההיסטוריה קצרה (כ-{years} שנים) - מסלול ההוכחה עדיין נבנה.",
        "en": "Short history (about {years} years) - still building a track record.",
        "ru": "Короткая история (около {years} лет) - репутация ещё формируется.",
        "es": "Historial corto (cerca de {years} años) - aún está construyendo su trayectoria.",
    },

    # ---------- Buyback (metric-level) ----------
    "bb_metric_none": {
        "he": "החברה לא רכשה בחזרה מניות בשנה האחרונה.",
        "en": "The company hasn't bought back shares in the last year.",
        "ru": "Компания не выкупала свои акции за последний год.",
        "es": "La empresa no ha recomprado acciones en el último año.",
    },
    "bb_reduces_shares": {
        "he": "החברה רכשה בחזרה מניות - מקטין את מספר המניות במחזור ומגדיל את הבעלות היחסית של כל משקיע קיים.",
        "en": "The company bought back shares - this reduces shares outstanding and increases each existing investor's relative ownership.",
        "ru": "Компания выкупила свои акции - это уменьшает количество акций в обращении и увеличивает относительную долю каждого существующего инвестора.",
        "es": "La empresa recompró acciones - esto reduce las acciones en circulación y aumenta la participación relativa de cada inversor existente.",
    },
    "bb_significant": {
        "he": "כ-{pct}% משווי השוק - תוכנית רכישה משמעותית.",
        "en": "About {pct}% of market cap - a significant buyback program.",
        "ru": "Около {pct}% от капитализации - значительная программа выкупа.",
        "es": "Aproximadamente el {pct}% de la capitalización - un programa de recompra significativo.",
    },
    "bb_moderate_pct": {
        "he": "כ-{pct}% משווי השוק.",
        "en": "About {pct}% of market cap.",
        "ru": "Около {pct}% от капитализации.",
        "es": "Aproximadamente el {pct}% de la capitalización.",
    },
    "bb_modest": {
        "he": "כ-{pct}% משווי השוק - היקף מתון.",
        "en": "About {pct}% of market cap - a modest amount.",
        "ru": "Около {pct}% от капитализации - небольшой объём.",
        "es": "Aproximadamente el {pct}% de la capitalización - un monto modesto.",
    },

    # ---------- Moat Signal (פרוקסי כמותי ליתרון תחרותי, עיקרון מאנגר) ----------
    "moat_no_history": {
        "he": "אין מספיק היסטוריה (נדרשות לפחות 3 שנים) להעריך יציבות יתרון תחרותי.",
        "en": "Not enough history (at least 3 years needed) to assess competitive-advantage stability.",
        "ru": "Недостаточно истории (нужно минимум 3 года) для оценки устойчивости конкурентного преимущества.",
        "es": "No hay suficiente historial (se necesitan al menos 3 años) para evaluar la estabilidad de la ventaja competitiva.",
    },
    "moat_strong": {
        "he": "שולי רווח גולמי גבוהים ויציבים על פני זמן - איתות חזק ליתרון תחרותי מתמשך.",
        "en": "High and stable gross margins over time - a strong signal of a durable competitive advantage.",
        "ru": "Высокая и стабильная валовая маржа на протяжении времени - сильный сигнал устойчивого конкурентного преимущества.",
        "es": "Márgenes brutos altos y estables a lo largo del tiempo - una señal sólida de una ventaja competitiva duradera.",
    },
    "moat_high_volatile": {
        "he": "שולי רווח גולמי גבוהים אך משתנים בין השנים - יתרון תחרותי אפשרי, אבל לא בהכרח עקבי.",
        "en": "High gross margins but inconsistent year to year - a possible competitive advantage, though not necessarily a reliable one.",
        "ru": "Высокая валовая маржа, но непостоянная из года в год - возможное конкурентное преимущество, но не обязательно надёжное.",
        "es": "Márgenes brutos altos pero inconsistentes de un año a otro - una posible ventaja competitiva, aunque no necesariamente fiable.",
    },
    "moat_moderate_stable": {
        "he": "שולי רווח גולמי מתונים אך יציבים - אולי לא moat חזק, אבל לפחות עקביות תחרותית.",
        "en": "Moderate but stable gross margins - maybe not a strong moat, but at least competitive consistency.",
        "ru": "Умеренная, но стабильная валовая маржа - возможно, не сильное защитное преимущество, но хотя бы конкурентная стабильность.",
        "es": "Márgenes brutos moderados pero estables - quizás no sea un foso fuerte, pero al menos hay consistencia competitiva.",
    },
    "moat_moderate_volatile": {
        "he": "שולי רווח גולמי מתונים ולא עקביים - לא נראה איתות חזק ליתרון תחרותי.",
        "en": "Moderate and inconsistent gross margins - doesn't look like a strong competitive-advantage signal.",
        "ru": "Умеренная и непостоянная валовая маржа - не выглядит как сильный сигнал конкурентного преимущества.",
        "es": "Márgenes brutos moderados e inconsistentes - no parece una señal sólida de ventaja competitiva.",
    },
    "moat_weak": {
        "he": "שולי רווח גולמי נמוכים - בעסקים כאלה קשה יותר לבודד יתרון תחרותי אמיתי לעומת תחרות מחירים.",
        "en": "Low gross margins - in businesses like this, it's harder to isolate a real competitive advantage from plain price competition.",
        "ru": "Низкая валовая маржа - в таких компаниях труднее выделить реальное конкурентное преимущество от простой ценовой конкуренции.",
        "es": "Márgenes brutos bajos - en negocios así es más difícil aislar una ventaja competitiva real de la simple competencia de precios.",
    },
}


# ---------- "דברים שכדאי לעקוב אחריהם" - תגי קטגוריה (news_signals.py) ----------
SIGNAL_CATEGORIES = {
    "leadership": {
        "he": "שינוי הנהלה", "en": "Leadership change", "ru": "Смена руководства", "es": "Cambio de liderazgo",
    },
    "legal_regulatory": {
        "he": "רגולציה / משפטי", "en": "Regulatory / Legal", "ru": "Регулирование / Юридическое",
        "es": "Regulatorio / Legal",
    },
    "mna": {
        "he": "מיזוג / רכישה", "en": "M&A", "ru": "Слияние / Поглощение", "es": "Fusión / Adquisición",
    },
    "analyst": {
        "he": "פעולת אנליסטים", "en": "Analyst action", "ru": "Действия аналитиков", "es": "Acción de analistas",
    },
    "major_event": {
        "he": "אירוע מהותי", "en": "Major event", "ru": "Значимое событие", "es": "Evento importante",
    },
}


def render_explanation(parts, lang="he"):
    """
    מקבל רשימת (key, params) ומחזיר משפט הסבר מתורגם, מחובר ברווחים.
    אם lang לא נמצא -> fallback לעברית.
    """
    pieces = []
    for key, params in parts:
        template_dict = EXPLANATIONS.get(key)
        if template_dict is None:
            continue
        template = template_dict.get(lang) or template_dict.get("he", "")
        try:
            pieces.append(template.format(**(params or {})))
        except Exception:
            pieces.append(template)
    return " ".join(pieces)


def translate_signal_category(key, lang="he"):
    cat = SIGNAL_CATEGORIES.get(key)
    if cat is None:
        return key
    return cat.get(lang) or cat.get("he", key)
