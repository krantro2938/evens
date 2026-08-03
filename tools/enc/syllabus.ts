// What the course is, as opposed to what the site's HTML happens to contain.
//
// Three things live here that cannot be scraped:
//
//   - Which section a topic belongs to. maga0's contents page groups the
//     articles under "Алгебра и геометрия" and "Математический анализ" in
//     prose, not markup.
//   - A SHORT title. The panel fits roughly 48 characters on a row, and
//     maga3's real title is "Линии на плоскости. Прямые, кривые и сами
//     плоскости. Поверхности" — a nav list of those is a list of ellipses.
//   - Search words. "По заданию" matches the scanned assignment against these,
//     so they include the phrasings an exam paper uses and the article does
//     not: an МИРЭА paper says "приведите к каноническому виду", the article
//     says "квадратичная форма".

export interface Topic {
    /** The site's article number — also the node id, so a node traces to a URL. */
    no: number;
    /** Fits a nav row. */
    short: string;
    /** Extra terms for the assignment matcher, beyond the article's own words. */
    keywords: string[];
}

export interface Section {
    id: string;
    title: string;
    topics: Topic[];
}

export const SECTIONS: Section[] = [
    {
        id: "alg",
        title: "Алгебра и геометрия",
        topics: [
            { no: 1, short: "Комплексные числа", keywords: ["мнимая единица", "модуль", "аргумент", "муавр", "корень из комплексного", "тригонометрическая форма", "показательная форма"] },
            { no: 2, short: "Матрицы и определители", keywords: ["определитель", "минор", "алгебраическое дополнение", "обратная матрица", "ранг", "система линейных уравнений", "крамер", "гаусс", "транспонирование"] },
            { no: 3, short: "Линии, плоскости, поверхности", keywords: ["прямая", "плоскость", "эллипс", "гипербола", "парабола", "кривая второго порядка", "поверхность второго порядка", "каноническое уравнение", "асимптота", "директриса", "эксцентриситет"] },
            { no: 4, short: "Линейные пространства", keywords: ["базис", "размерность", "линейная независимость", "подпространство", "координаты вектора", "замена базиса"] },
            { no: 5, short: "Линейные операторы", keywords: ["матрица оператора", "ядро", "образ", "ранг оператора", "дефект", "замена базиса"] },
            { no: 6, short: "Операторы: собственные значения", keywords: ["собственный вектор", "собственное значение", "характеристический многочлен", "диагонализация", "спектр"] },
            { no: 7, short: "Билинейные и квадратичные формы", keywords: ["квадратичная форма", "билинейная форма", "канонический вид", "закон инерции", "сильвестр", "знакоопределённость", "лагранж"] },
            { no: 8, short: "Евклидово пространство", keywords: ["скалярное произведение", "ортогональный", "ортонормированный", "грам", "шмидт", "коши", "буняковский", "симметричный оператор", "ортогональная матрица"] },
        ],
    },
    {
        id: "ana",
        title: "Математический анализ",
        topics: [
            { no: 10, short: "Пределы", keywords: ["предел", "бесконечно малая", "эквивалентность", "неопределённость", "лопиталь", "асимптота", "непрерывность", "разрыв"] },
            { no: 11, short: "Производные", keywords: ["производная", "дифференциал", "касательная", "экстремум", "монотонность", "выпуклость", "точка перегиба", "исследование функции"] },
            { no: 12, short: "Функции нескольких переменных", keywords: ["частная производная", "градиент", "полный дифференциал", "экстремум функции двух переменных", "условный экстремум", "лагранж", "производная по направлению", "гессиан"] },
            { no: 13, short: "Неопределённые интегралы", keywords: ["первообразная", "интегрирование по частям", "замена переменной", "рациональная дробь", "простейшие дроби", "тригонометрическая подстановка", "таблица интегралов"] },
            { no: 14, short: "Определённые интегралы", keywords: ["ньютон", "лейбниц", "площадь", "длина дуги", "объём тела вращения", "несобственный интеграл", "полярные координаты"] },
            { no: 15, short: "Кратные и криволинейные интегралы", keywords: ["двойной интеграл", "тройной интеграл", "криволинейный интеграл", "поверхностный интеграл", "якобиан", "грин", "стокс", "остроградский"] },
            { no: 16, short: "Ряды", keywords: ["числовой ряд", "сходимость", "признак даламбера", "признак коши", "степенной ряд", "радиус сходимости", "тейлор", "маклорен", "фурье"] },
        ],
    },
    {
        id: "de",
        title: "Дифференциальные уравнения",
        topics: [
            { no: 17, short: "Дифференциальные уравнения", keywords: ["дифференциальное уравнение", "разделяющиеся переменные", "однородное", "линейное первого порядка", "бернулли", "характеристическое уравнение", "общее решение", "частное решение", "задача коши"] },
        ],
    },
    {
        id: "misc",
        title: "Прочие задачи",
        topics: [
            { no: 9, short: "Задачи демовариантов", keywords: ["демовариант", "вступительный экзамен", "магистратура"] },
        ],
    },
];

export const TOPICS: Topic[] = SECTIONS.flatMap((s) => s.topics);

export const topicOf = (no: number): Topic | undefined => TOPICS.find((t) => t.no === no);

/**
 * Headings whose whole section is site furniture rather than content.
 *
 * "Оглавление" is the article's own table of contents — the browser this pack
 * feeds is a better one, and keeping it would mean a contents page inside a
 * contents page. "Комментарии" is the comment widget's heading.
 */
export const DROP_SECTION =
    /^(комментари|оглавление|содержание|список использованной литературы|литератур|использованн|источник)/i;

/** An h2 that opens the worked problems. Everything after it is examples. */
export const EXERCISES_HEADING =
    /^(упражнени|примеры задач|решение заданий|решение остальных заданий|задани|задачи)/i;

/** An h3 that opens one problem. */
export const CONDITION_HEADING = /^услови/i;

/** Headings inside a problem that are part of it, not new sections. */
export const WITHIN_EXAMPLE = /^(решение|проверка|примечание|подготовка|вывод|ответ|итог)/i;
