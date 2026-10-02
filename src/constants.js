export const extensionName = "persona-forge";

// manifest.json의 version과 같게 — 바뀌면 설치·업데이트 후 한 번 안내 창을 띄움
export const EXTENSION_VERSION = '2.2.0';

// 글자 크기 — 대장간 창 전체(ui)와 모루 남매 대화(chat) 배율
export const FONT_SCALES = {
    small: { label: '작게', ui: 0.93, chat: 0.92 },
    medium: { label: '보통', ui: 1, chat: 1 },
    large: { label: '크게', ui: 1.08, chat: 1.15 },
};

function detectExtensionPath() {
    try {
        if (typeof import.meta !== 'undefined' && import.meta.url) {
            const root = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
            if (root) return root;
        }
    } catch (e) {
        console.warn('[persona-forge] Extension path detection failed:', e);
    }
    return `scripts/extensions/third-party/ST-Persona-Forge`;
}

export const extensionFolderPath = detectExtensionPath();

export const LANGUAGES = {
    en: { label: 'English', promptName: 'English', nameExample: 'Haruka (遥)', you: 'you', nameLabel: '' },
    ko: { label: '한국어', promptName: 'Korean (한국어)', nameExample: '카이토(海斗)', you: '당신', nameLabel: '이름' },
    ja: { label: '日本語', promptName: 'Japanese (日本語)', nameExample: 'アリス(Alice)', you: 'あなた', nameLabel: '名前' },
    zh: { label: '中文 (간체)', promptName: 'Simplified Chinese (简体中文)', nameExample: '爱丽丝(Alice)', you: '你', nameLabel: '姓名' },
    'zh-tw': { label: '中文 (번체)', promptName: 'Traditional Chinese (繁體中文)', nameExample: '愛麗絲(Alice)', you: '你', nameLabel: '姓名' },
};

export const FORGE_MODES = {
    PERSONA: 'persona',
    BOT: 'bot',
};

export const BOT_DIRECTIONS = {
    relational: { label: '관계 중심', slot: 'directionRelational' },
    independent: { label: '독립 인물', slot: 'directionIndependent' },
};

export const GREETING_LENGTHS = {
    short: { label: '짧게', paragraphs: '4–5' },
    medium: { label: '보통', paragraphs: '6–7' },
    long: { label: '길게', paragraphs: '8–10' },
    custom: { label: '직접 입력', paragraphs: '' },
};

export const GREETING_POVS = {
    third: { label: '전지적 3인칭' },
    second: { label: '2인칭 ({{user}} = 당신)' },
};

export const DENSITY_LEVELS = {
    default: { label: '기본형', desc: '분량을 따로 조절하지 않습니다', slot: '' },
    detailed: { label: '상세형', desc: '항목마다 필요한 만큼 자세하게, 형용사 나열보다 완전한 문장으로', slot: 'densityDetailed' },
    concise: { label: '밸런스형', desc: '중요한 정보는 충분히 풀고, 사소한 것은 짧게 줄임', slot: 'density' },
    compact: { label: '압축형', desc: '전체를 짧게 압축하고, 핵심만 간결하게 남김', slot: 'densityCompact' },
};

// 추가 지침이 들어갈 자리 (프롬프트 탭에서 페르소나·봇 추가 지침마다 고름) — 생성·섹션 재생성·전체 수정
export const GUIDELINE_PLACEMENTS = {
    user: { label: '사용자 메시지 · 컨셉/지시 뒤 (기본)' },
    craft: { label: '시스템 · 작성 기준 끝 (분량 뒤)' },
    afterUser: { label: '시스템 · 컨셉 뒤, NSFW 지침 앞' },
    beforeFormat: { label: '시스템 · NSFW 지침 뒤, 출력 형식 앞' },
};

export const GENERATION_MODES = {
    FREE: 'free',
    GUIDED: 'guided',
};

// 봇 모드 "세계관 설정"의 기본 항목 (작성 순서는 설정 탭에서 고른 순서)
export const SETTING_FIELDS = {
    world: { label: '세계 개요', labelEn: 'WORLD', description: 'genre, era, technology level, and how the world broadly works', descriptionKo: '장르, 시대, 기술 수준, 세계가 대략 어떻게 돌아가는지', icon: 'fa-solid fa-earth-asia' },
    environment: { label: '환경', labelEn: 'ENVIRONMENT', description: 'climate, landscape, and the feel of everyday surroundings', descriptionKo: '기후, 풍경, 일상 주변의 분위기', icon: 'fa-solid fa-mountain-sun' },
    everyday_life: { label: '생활상', labelEn: 'DAILY LIFE', description: 'what people eat, wear, and do for a living, money and prices, everyday customs and taboos', descriptionKo: '먹고 입고 먹고사는 방식, 돈과 물가, 일상의 관습과 금기', icon: 'fa-solid fa-bread-slice' },
    places: { label: '주요 장소', labelEn: 'PLACES', description: 'key regions, cities, and places the story is likely to visit', descriptionKo: '이야기에 나올 만한 주요 지역·도시·장소', icon: 'fa-solid fa-map-location-dot' },
    factions: { label: '주요 세력', labelEn: 'FACTIONS', description: 'major groups, organizations, and powers, and how they relate to each other; where it helps, their key branches or divisions', descriptionKo: '주요 집단·단체·세력과 서로의 관계 (필요하면 주요 부서·하위 조직도)', icon: 'fa-solid fa-flag' },
    tensions: { label: '긴장 · 갈등', labelEn: 'TENSIONS', description: 'conflicts, pressures, and brewing problems right now that can drive scenes and draw {{user}} in', descriptionKo: '지금 진행 중인 갈등·압박·터질 듯한 문제, 장면을 움직이고 {{user}}를 끌어들일 거리', icon: 'fa-solid fa-scale-unbalanced' },
    history: { label: '역사', labelEn: 'HISTORY', description: 'important past events that still shape the present', descriptionKo: '지금까지 영향을 주는 중요한 과거 사건', icon: 'fa-solid fa-landmark' },
    lore: { label: '신화·전설', labelEn: 'LORE', description: 'myths, legends, beliefs, and religions', descriptionKo: '신화, 전설, 믿음과 종교', icon: 'fa-solid fa-book-skull' },
    glossary: { label: '용어집', labelEn: 'GLOSSARY', description: "the world's own terms, titles, and names, each with a short explanation", descriptionKo: '세계 고유의 용어·호칭·이름과 짧은 설명', icon: 'fa-solid fa-book-bookmark' },
    notes: { label: '기타 배경', labelEn: 'BACKGROUND NOTES', description: 'other background worth knowing for the roleplay', descriptionKo: '그 밖에 롤플레이에 알아 둘 배경', icon: 'fa-solid fa-note-sticky' },
};
// 처음에는 아무것도 고르지 않음 (쓰는 사람이 필요한 항목만 골라 켬)
export const DEFAULT_SETTING_FIELDS = [];

export const PROFILE_FIELDS = {
    basics: {
        id: 'basics',
        label: '기본 정보',
        labelEn: 'BASICS',
        description: 'name, age, sex, race or species, birthday, occupation, current residence',
        descriptionKo: '이름, 나이, 성별, 종족, 생일, 직업, 현 거주지',
        icon: 'fa-solid fa-id-card',
    },
    appearance: {
        id: 'appearance',
        label: '외모',
        labelEn: 'APPEARANCE',
        description: 'height and build, hair and eyes, distinctive features, usual clothing, scent',
        descriptionKo: '키·체형, 머리카락·눈, 특징, 평소 복장, 체취',
        icon: 'fa-solid fa-user',
    },
    background: {
        id: 'background',
        label: '배경',
        labelEn: 'BACKGROUND',
        description: "origin, formative events, past relationships, how they came to be in the story's current situation",
        descriptionKo: '출신, 인생을 만든 사건, 과거 관계, 지금 이야기의 상황에 이르게 된 경위',
        icon: 'fa-solid fa-book-open',
    },
    personality: {
        id: 'personality',
        label: '성격',
        labelEn: 'PERSONALITY',
        description: 'core concept, traits, likes, dislikes, desires, fears, weaknesses',
        descriptionKo: '핵심 컨셉, 성격 특성, 좋아하는 것, 싫어하는 것, 욕구, 두려움, 약점',
        icon: 'fa-solid fa-gem',
    },
    goals: {
        id: 'goals',
        label: '목표 & 동기',
        labelEn: 'GOALS & MOTIVATIONS',
        description: 'what they consciously want and pursue now, why, and what stands in the way',
        descriptionKo: '지금 의식적으로 원하고 좇는 것, 그 이유, 가로막는 것',
        icon: 'fa-solid fa-bullseye',
    },
    daily_life: {
        id: 'daily_life',
        label: '일상 & 루틴',
        labelEn: 'DAILY LIFE & ROUTINE',
        description: 'a typical day: work or duties, routines, places they frequent, and how they live (who they live with, how they spend money and free time)',
        descriptionKo: '평소 하루: 일이나 맡은 일, 일과, 자주 가는 곳, 사는 모습 (누구와 사는지, 돈과 여가를 어떻게 쓰는지)',
        icon: 'fa-solid fa-mug-saucer',
    },
    quirks: {
        id: 'quirks',
        label: '버릇 & 습관',
        labelEn: 'QUIRKS & HABITS',
        description: "habits and behavioral quirks, including ones they don't notice",
        descriptionKo: '습관과 행동의 버릇 (본인이 모르는 것 포함)',
        icon: 'fa-solid fa-puzzle-piece',
    },
    skills: {
        id: 'skills',
        label: '능력 & 기술',
        labelEn: 'SKILLS',
        description: 'skills, abilities, areas of expertise',
        descriptionKo: '기술, 능력, 전문 분야',
        icon: 'fa-solid fa-bolt',
    },
    relationships: {
        id: 'relationships',
        label: '관계',
        labelEn: 'RELATIONSHIPS',
        description: "their relationship and dynamic with the target character, only if they already have one (if they haven't met yet, leave the target character out of this section entirely); their social standing (reputation and how they treat others); other people who matter to them",
        descriptionKo: '기존 캐릭터와의 관계와 역학 (이미 관계가 있는 경우에만. 아직 만나지 않았다면 이 섹션에서 기존 캐릭터를 아예 언급하지 않음), 사회적 위치 (평판과 사람을 대하는 태도), 그 밖에 중요한 사람들',
        botDescription: 'their relationship and dynamic with {{user}}, or how they treat people they meet if no relationship is set; other people who matter to them',
        botDescriptionKo: '{{user}}와의 관계와 역학 (정해진 관계가 없으면 처음 만나는 사람을 대하는 방식), 그 밖에 중요한 사람들',
        icon: 'fa-solid fa-heart',
    },
    hidden_desires: {
        id: 'hidden_desires',
        label: '숨겨진 욕망',
        labelEn: 'HIDDEN DESIRES & GUILT',
        description: 'inner conflicts, secret desires, what they feel guilty about and how they live with it',
        descriptionKo: '내적 갈등, 숨긴 욕망, 죄책감의 대상과 그것을 안고 사는 방식',
        icon: 'fa-solid fa-moon',
    },
    speech: {
        id: 'speech',
        label: '말투 & 대사',
        labelEn: 'SPEECH EXAMPLES',
        description: 'speech style (tone, formality, verbal habits) and 3–5 sample lines',
        descriptionKo: '말투(어조, 존댓말 수준, 말버릇)와 예시 대사 3~5줄',
        icon: 'fa-solid fa-comment-dots',
    },
    nsfw_appearance: {
        id: 'nsfw_appearance',
        label: 'NSFW 외모',
        labelEn: 'NSFW APPEARANCE',
        description: "intimate physical details (shape, grooming, and how their body responds, such as fluids); exact size isn't required, but if a man's size is described, treat 20 cm or more as large",
        descriptionKo: '은밀한 신체적 세부 사항 (형태, 관리 상태, 체질에 따른 반응·체액 등). 정확한 크기는 꼭 쓰지 않아도 되지만, 남성의 크기를 묘사할 때는 20cm 이상을 \'크다\'로 봄',
        icon: 'fa-solid fa-eye-slash',
        nsfw: true,
    },
    sexual_preferences: {
        id: 'sexual_preferences',
        label: '성적 취향',
        labelEn: 'ROMANTIC & SEXUAL PREFERENCES',
        description: 'romantic style and sexual behavior, in prose, limited to what is distinctive about this character; kinks on a single line as a comma-separated list of short terms (for example "overstimulation, marking, praise kink"), with a brief note in parentheses only where one is needed',
        descriptionKo: '연애 방식과 성적 행동 (서술형, 이 인물만의 특징적인 부분만), 성벽은 한 줄에 짧은 용어를 쉼표로 나열 (예: "overstimulation, marking, praise kink", 꼭 필요할 때만 괄호로 짧은 설명)',
        icon: 'fa-solid fa-fire',
        nsfw: true,
    },
    ai_guidelines: {
        id: 'ai_guidelines',
        label: 'AI 가이드라인',
        labelEn: 'AI GUIDELINES',
        description: 'notes for the roleplay AI: the traits and details it is most likely to get wrong, to keep consistent',
        descriptionKo: '롤플레이 AI를 위한 메모: 연기할 때 틀리기 쉬운, 일관되게 유지할 핵심 특성·디테일',
        botDescription: 'notes for the AI playing this character: the points it is most likely to get wrong, such as what they would never do and traits or details to keep consistent',
        botDescriptionKo: '이 캐릭터를 연기할 AI를 위한 메모: 틀리기 쉬운 핵심 (절대 하지 않을 행동, 일관되게 유지할 특성·디테일)',
        icon: 'fa-solid fa-robot',
    },
    character_notes: {
        id: 'character_notes',
        label: '트리비아',
        labelEn: 'TRIVIA',
        description: 'other notes and interesting facts',
        descriptionKo: '기타 메모와 흥미로운 사실',
        icon: 'fa-solid fa-note-sticky',
    },
};

export const TEMPLATE_PRESETS = {
    basic: {
        id: 'basic',
        label: 'Basic (기본)',
        description: '핵심 정보만 간략하게',
        fields: ['basics', 'appearance', 'personality'],
    },
    standard: {
        id: 'standard',
        label: 'Standard (표준)',
        description: '일반적인 수준의 상세한 프로필',
        fields: ['basics', 'appearance', 'background', 'personality', 'goals', 'relationships', 'speech'],
    },
    detailed: {
        id: 'detailed',
        label: 'Detailed (상세)',
        description: '심층적인 캐릭터 프로필',
        fields: ['basics', 'appearance', 'background', 'personality', 'goals', 'daily_life', 'quirks', 'skills', 'relationships', 'speech', 'character_notes'],
    },
    full: {
        id: 'full',
        label: 'Full (전체)',
        description: '모든 항목을 포함한 완전한 프로필',
        fields: ['basics', 'appearance', 'background', 'personality', 'goals', 'daily_life', 'quirks', 'skills', 'relationships', 'hidden_desires', 'speech', 'nsfw_appearance', 'sexual_preferences', 'ai_guidelines', 'character_notes'],
    },
};

export const MIRROR_TEMPLATE = {
    id: 'mirror',
    label: 'Mirror (기존 캐릭터 참고)',
};

export const CARD_FIELDS = {
    description: { label: '캐릭터 설명', tag: 'description', always: true },
    personality: { label: '성격 요약', tag: 'personality', defaultOn: false },
    scenario: { label: '시나리오', tag: 'scenario', defaultOn: false },
    first_mes: { label: '첫 번째 메시지', tag: 'first_message', defaultOn: false },
    alternate_greetings: { label: '대체 인사말', tag: 'alternate_greetings', defaultOn: false },
    mes_example: { label: '대화 예시', tag: 'example_dialogue', defaultOn: false },
    depth_prompt: { label: '캐릭터 노트', tag: 'character_note', defaultOn: false },
    creator_notes: { label: '제작자 메모 (작가 노트)', tag: 'creator_notes', defaultOn: false },
    system_prompt: { label: '카드 시스템 프롬프트', tag: 'card_system_prompt', defaultOn: false },
    post_history_instructions: { label: '카드 기록 후 지시문', tag: 'post_history_instructions', defaultOn: false },
};

export const defaultSettings = {
    forgeMode: FORGE_MODES.PERSONA,

    botDirection: 'relational',
    botPersona: '',
    // 페르소나 모드: 바탕으로 삼을 내 기존 페르소나 (MANUAL_PERSONA_ID면 직접 입력한 내용)
    personaBase: '',
    manualPersona: { name: '', description: '' },
    botNotes: { name: '', description: '' },

    greetingLength: 'medium',
    greetingLengthCustom: '',
    greetingPov: 'third',

    density: 'default',

    generationMode: GENERATION_MODES.FREE,
    templatePreset: 'standard',
    language: 'en',

    customFields: [],

    customFieldDefinitions: {},

    sheetTemplate: '',

    connectionProfile: '',

    // 대화형 서포터 (결과 아래 대화창) — 연결 프로필(비우면 메인 연결 프로필), 캐릭터 성별, 나를 부를 이름
    // (모든 결과의 대화에 똑같이 적용 — 대화 내용만 결과마다 따로)
    supporterProfile: '',
    supporterGender: 'female',
    supporterUserName: '',
    // 글자 크기 (small | medium | large) — 대장간 창 전체 / 모루 남매 대화
    uiFontSize: 'medium',
    chatFontSize: 'medium',
    // 글꼴 (pretendard: 확장 글꼴 | theme: 실리태번 테마 글꼴)
    uiFontFamily: 'pretendard',
    // NSFW 지침 (켜면 번역을 뺀 모든 생성·서포터 대화에 <smut_guidance>)
    matureContent: false,
    // 추가 지침이 들어갈 자리 { 슬롯: GUIDELINE_PLACEMENTS 키 }
    guidelinesPlacement: { guidelines: 'user', botGuidelines: 'user' },
    // 마지막으로 업데이트 안내를 본 버전 (다르면 한 번 안내)
    lastSeenVersion: '',
    // 작가(나)의 성별('' | female | male)과 짧은 자기소개 — 모루 남매에게 작가를 알려 줌 ({{user}}와는 별개)
    supporterUserGender: '',
    supporterUserIntro: '',
    // 직접 올린 프로필 이미지 (성별·표정마다, 256px로 줄인 data URL) — 비어 있으면 기본 이미지
    supporterAvatars: { female: {}, male: {} },

    // 최대 출력 토큰 (0 = 실리태번/연결 프로필 설정 따르기)
    maxTokens: 0,

    // 스트리밍으로 받기 (Chat Completion) — 오래 걸리는 생성이 중계 서버 시간 초과로 끊기는 것을 막음
    streamRequests: false,

    includeWorldInfo: false,

    // 봇 모드: 프로필 앞에 세계관(# Setting) 블록도 함께 씀 — 항목은 Choice처럼 고르고 순서·내용을 바꿀 수 있음
    includeSetting: false,
    // 봇 모드: 끄면 캐릭터 프로필 없이 세계관만 (둘 다 끄면 생성하지 않음)
    includeCharacter: true,
    settingFields: [...DEFAULT_SETTING_FIELDS],
    settingFieldDefinitions: {},

    // 스포일러 방지 (참고 캐릭터의 비밀을 프로필에 드러내지 않도록 지시) — 창작 자유도가 낮아질 수 있어 기본 끔
    spoilerProtection: false,
    // 원작 몰라도 OK (페르소나) — 원작 설정을 몰라도 바로 플레이할 수 있는 페르소나를 짜도록 지시
    unfamiliarSource: false,

    manualCharacter: { name: '', description: '' },

    wiSelections: {},

    // 참고할 카드 항목 { [CARD_FIELDS 키]: bool } — 비어 있으면 각 항목의 defaultOn
    cardFields: {},

    autoSaveHistory: true,

    completionSound: true,

    forgedCount: null,
    // 제목 망치를 두드린 횟수 (숨은 칭호용)
    hammerTaps: 0,

    // 수정한 프롬프트 { [PROMPT_SLOTS 키]: 텍스트 } — 키가 없으면 기본 프롬프트 사용
    // 여러 탭에 있는 칸(문체 규칙·분량 등)은 탭마다 따로: "칸@탭" (예: writingStyle@bot)
    customPrompts: {},
    // 프롬프트 칸의 표시 이름 { [PROMPT_SLOTS 키]: 이름 } — 목록·구조 안내에만 쓰임
    promptLabels: {},

    // (구버전) 커스텀 시스템 프롬프트 — 불러올 때 이전 버전 보관함으로 옮김
    customSystemPrompt: '',

    promptPresets: [],

    // 이전 버전 프롬프트 보관함 (새 구조에 맞지 않아 적용하지 않고 읽기 전용으로 보관)
    // [{ name, prompts: { [구버전 키]: 텍스트 } }]
    legacyPrompts: [],

    // (구버전) 기록 — 이제 실리태번 사용자 파일(persona-forge-history.json)에 저장하며,
    // 파일 저장을 쓸 수 없는 환경에서만 여기에 저장
    history: [],
};

export const FORGE_RANKS = [
    { min: 0, name: '견습 대장장이' },
    { min: 10, name: '숙련 대장장이' },
    { min: 30, name: '장인' },
    { min: 100, name: '전설의 대장장이' },
];

// 숨은 칭호 — 제목 망치를 두드린 횟수에 따라 기존 칭호 앞에 붙음
export const HAMMER_TITLES = [
    { min: 100, name: '손목 시큰한' },
    { min: 300, name: '망치에 홀린' },
    { min: 500, name: '모루도 겁내는' },
];

export const MANUAL_PERSONA_ID = '__manual__';

export const RESETTABLE_SETTING_KEYS = [
    'forgeMode', 'botDirection', 'botPersona', 'personaBase', 'greetingLength', 'greetingLengthCustom', 'greetingPov', 'density',
    'generationMode', 'templatePreset', 'customFields', 'language', 'connectionProfile', 'maxTokens',
    'includeWorldInfo', 'includeSetting', 'includeCharacter', 'settingFields', 'supporterProfile', 'supporterGender', 'supporterUserName', 'supporterUserGender', 'supporterUserIntro', 'uiFontSize', 'chatFontSize', 'uiFontFamily', 'cardFields', 'autoSaveHistory', 'completionSound', 'spoilerProtection', 'unfamiliarSource', 'matureContent', 'streamRequests',
];

// 대화형 서포터 표정 — 모델이 답마다 <face>로 고름 (이미지가 없는 표정은 기본 표정으로)
export const SUPPORTER_FACES = [
    { id: 'neutral', label: '기본' },
    { id: 'smile', label: '미소' },
    { id: 'surprised', label: '놀람' },
    { id: 'shy', label: '수줍음' },
];

// 대화형 서포터 기본 프로필 이미지 (성별·표정별 이미지 주소 — 비어 있으면 아이콘)
export const SUPPORTER_AVATARS = {
    female: {
        neutral: 'https://i.ibb.co/RkdWbctf/Woman-Neutral.jpg',
        smile: 'https://i.ibb.co/TMRBQhkG/Woman-Smile.jpg',
        surprised: 'https://i.ibb.co/qLF5QXmc/Woman-Surprise.jpg',
        shy: 'https://i.ibb.co/3Y4z4JDx/Woman-Shy.jpg',
    },
    male: {
        neutral: 'https://i.ibb.co/kr3fk4g/Man-Neutral.jpg',
        smile: 'https://i.ibb.co/Vc5v7M1S/Man-Smile.jpg',
        surprised: 'https://i.ibb.co/B5z67xSM/Man-Surprise.jpg',
        shy: 'https://i.ibb.co/FqNGNhbp/Man-Shy.jpg',
    },
};

// 기록 보관 개수 — 넘으면 즐겨찾기가 아닌 오래된 기록부터 지움 (기록은 저장할 때마다 파일 전체를 다시 쓰므로 무한히 두지 않음)
export const HISTORY_LIMIT = 200;
// 이 개수부터 기록 탭에 "곧 오래된 기록이 지워진다" 안내
export const HISTORY_WARN_AT = 180;

// 기록 파일 이름 (실리태번 data/<사용자>/user/files/ 에 저장)
export const HISTORY_FILE_NAME = 'persona-forge-history.json';
