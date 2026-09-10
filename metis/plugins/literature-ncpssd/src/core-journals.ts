/**
 * 核心期刊白名单（LIT-CORE-01）。
 *
 * 中文：CSSCI（2023–2024 来源期刊）+ 北大核心（2023 版社科高频）+ CSCD 社科相关。
 * 英文：SCI / SSCI 期刊 ISSN（按近年 JCR 主流期刊整理）。
 *
 * 名单为静态精选集：仅收录可确信真实存在的期刊/ISSN，可持续扩充
 * （新增条目追加到对应数组并递增 JOURNAL_LIST_VERSION）。
 * 注意：NCPSSD 期刊核心标识页为 JS 动态加载、无公开稳定接口，在线校验
 * 暂未实现，白名单是唯一判据 —— 覆盖不到的核心刊可在检索时取消核心过滤。
 */

/** 白名单数据版本（每次扩充递增；设置页展示，用于判断名单新旧）。 */
export let JOURNAL_LIST_VERSION = 2;
export const JOURNAL_LIST_STATS = {
  chineseCoreJournals: 0, // 装载时填充（见文件底部）
  sciSsciIssns: 0,
};

/** 中文核心期刊名（规范化：去除书名号/空白后精确匹配）。 */
export const CHINESE_CORE_JOURNALS: readonly string[] = [
  // 综合性社科期刊
  '中国社会科学', '学术月刊', '社会科学战线', '社会科学研究', '开放时代', '探索与争鸣',
  '江海学刊', '江汉论坛', '江苏社会科学', '浙江社会科学', '广东社会科学', '山东社会科学',
  '河南社会科学', '河北学刊', '学海', '求索', '中州学刊', '人文杂志', '东岳论丛', '学术界',
  '社会科学辑刊', '福建论坛', '江西社会科学', '云南社会科学', '贵州社会科学', '甘肃社会科学',
  '内蒙古社会科学', '新疆社会科学', '青海社会科学', '宁夏社会科学', '太平洋学报', '国外社会科学',
  '社会科学', '南京社会科学', '天津社会科学', '北京社会科学', '重庆社会科学', '黑龙江社会科学',
  // 高校学报（社科综合）
  '北京大学学报(哲学社会科学版)', '清华大学学报(哲学社会科学版)', '中国人民大学学报',
  '北京师范大学学报(社会科学版)', '复旦学报(社会科学版)', '南京大学学报(哲学·人文科学·社会科学)',
  '浙江大学学报(人文社会科学版)', '武汉大学学报(哲学社会科学版)', '中山大学学报(社会科学版)',
  '吉林大学社会科学学报', '四川大学学报(哲学社会科学版)', '山东大学学报(哲学社会科学版)',
  '厦门大学学报(哲学社会科学版)', '南开大学学报(哲学社会科学版)', '华中师范大学学报(人文社会科学版)',
  '华东师范大学学报(哲学社会科学版)', '东北师大学报(哲学社会科学版)', '陕西师范大学学报(哲学社会科学版)',
  '西南大学学报(社会科学版)', '南京师大学报(社会科学版)', '湖南师范大学社会科学学报',
  '华南师范大学学报(社会科学版)', '首都师范大学学报(社会科学版)', '上海师范大学学报(哲学社会科学版)',
  '安徽大学学报(哲学社会科学版)', '苏州大学学报(哲学社会科学版)', '河南大学学报(社会科学版)',
  '山西大学学报(哲学社会科学版)', '河北大学学报(哲学社会科学版)', '辽宁大学学报(哲学社会科学版)',
  // 哲学
  '哲学研究', '哲学动态', '世界哲学', '中国哲学史', '伦理学研究', '道德与文明', '自然辩证法研究',
  '自然辩证法通讯', '科学技术哲学研究', '宗教学研究', '世界宗教研究', '孔子研究', '周易研究',
  // 历史学
  '历史研究', '中国史研究', '近代史研究', '世界历史', '史学理论研究', '史学史研究', '史学月刊',
  '史学集刊', '史林', '中国社会经济史研究', '中国边疆史地研究', '当代中国史研究', '抗日战争研究',
  '民国档案', '历史档案', '清史研究', '中国农史', '自然科学史研究', '中国科技史杂志', '文史',
  '中华文史论丛', '文献', '中国典籍与文化', '考古', '考古学报', '文物', '考古与文物', '江汉考古',
  // 经济学
  '经济研究', '经济学(季刊)', '世界经济', '中国工业经济', '金融研究', '管理世界', '数量经济技术经济研究',
  '中国农村经济', '农业经济问题', '经济理论与经济管理', '经济学家', '经济科学', '财经研究', '财贸经济',
  '国际金融研究', '世界经济研究', '国际贸易问题', '南开经济研究', '经济评论', '经济纵横', '当代经济研究',
  '政治经济学评论', '中国经济问题', '宏观经济研究', '改革', '上海经济研究', '南方经济', '产业经济研究',
  // 法学
  '中国法学', '法学研究', '中外法学', '法商研究', '法学', '现代法学', '法律科学(西北政法大学学报)',
  '法制与社会发展', '政法论坛', '比较法研究', '环球法律评论', '清华法学', '当代法学', '法学论坛',
  '法学评论', '政治与法律', '行政法学研究', '中国刑事法杂志', '知识产权', '华东政法大学学报',
  // 政治学 / 社会学 / 民族学
  '政治学研究', '世界经济与政治', '国际问题研究', '现代国际关系', '外交评论', '国际政治研究',
  '社会学研究', '社会', '中国社会科学评价', '人口研究', '中国人口科学', '社会建设', '青年研究',
  '民族研究', '世界民族', '广西民族研究', '中央民族大学学报(哲学社会科学版)', '西南民族大学学报(人文社会科学版)',
  '公共管理学报', '中国行政管理', '国家行政学院学报', '公共行政评论', '北京行政学院学报', '求实', '理论探索',
  // 马克思主义
  '马克思主义研究', '马克思主义与现实', '思想理论教育导刊', '教学与研究', '科学社会主义',
  '中国特色社会主义研究', '社会主义研究', '毛泽东邓小平理论研究', '中共党史研究', '党的文献',
  // 教育学
  '教育研究', '高等教育研究', '中国高教研究', '教育发展研究', '教育学报', '比较教育研究', '外国教育研究',
  '课程·教材·教法', '中国教育学刊', '教育科学', '教育研究与实验', '华东师范大学学报(教育科学版)',
  '北京大学教育评论', '清华大学教育研究', '现代远程教育研究', '开放教育研究', '远程教育杂志', '电化教育研究',
  // 文学 / 语言学 / 新闻传播
  '文学评论', '文学遗产', '文艺研究', '文艺理论研究', '中国现代文学研究丛刊', '中国比较文学',
  '外国文学评论', '外国文学研究', '外国文学', '当代外国文学', '国外文学', '中国语文', '语言研究',
  '方言', '世界汉语教学', '语言文字应用', '当代语言学', '汉语学报', '新闻与传播研究', '国际新闻界',
  '新闻大学', '现代传播(中国传媒大学学报)', '出版发行研究', '编辑学报', '中国出版', '中国编辑',
  // 图书情报档案
  '中国图书馆学报', '图书情报工作', '图书情报知识', '情报学报', '情报理论与实践', '档案学研究',
  '档案学通讯', '图书馆学研究', '图书馆论坛', '大学图书馆学报',
  // 管理 / 心理 / 体育 / 艺术
  '管理科学学报', '系统工程理论与实践', '中国管理科学', '管理评论', '管理学报', '南开管理评论',
  '科研管理', '科学学研究', '科学学与科学技术管理', '心理学报', '心理科学', '心理发展与教育',
  '体育科学', '中国体育科技', '体育学研究', '艺术学研究', '音乐研究', '美术研究', '装饰', '电影艺术',
  // ─── v2 扩充（CSSCI 2023-2024 / 北大核心 2023 常用社科刊）───
  // 综合社科
  '学术交流', '齐鲁学刊', '湖南社会科学', '湖北社会科学', '广西社会科学', '学术探索',
  '理论导刊', '浙江学刊', '兰州学刊', '学术论坛', '社会科学家', '理论与现代化',
  // 哲学
  '现代哲学', '哲学分析',
  // 经济
  '经济学动态', '税务研究', '会计研究', '审计研究', '统计研究', '中国软科学',
  '中国人口·资源与环境', '城市问题', '城市发展研究', '中国农村观察', '保险研究',
  '国际经贸探索', '当代财经', '中央财经大学学报', '财经论丛', '经济与管理研究',
  // 法学
  '法学杂志', '政法论丛', '法治研究', '东方法学',
  // 社会学 / 人口
  '社会学评论', '人口与发展', '南方人口', '西北人口',
  // 国际政治 / 区域
  '东北亚论坛', '日本学刊', '俄罗斯中亚东欧研究', '国际展望',
  // 教育
  '复旦教育论坛', '国家教育行政学院学报', '教育与经济', '高等工程教育研究',
  '研究生教育研究', '中国高等教育',
  // 文学 / 文化
  '读书', '当代作家评论', '小说评论', '民族文学研究', '文艺争鸣', '南方文坛',
  // 新闻传播 / 出版
  '编辑之友', '中国科技期刊研究', '科技与出版', '出版广角',
  // 管理 / 信息
  '外国经济与管理', '研究与发展管理', '经济与管理', '管理案例研究与评论',
  // 心理
  '心理科学进展', '心理与行为研究',
  // 旅游
  '旅游学刊', '旅游科学',
  // 历史 / 考古补充
  '敦煌研究', '故宫博物院院刊', '中国历史地理论丛',
];

/** SCI / SSCI 期刊 ISSN（印刷或电子 ISSN 均可匹配）。 */
export const SCI_SSCI_ISSNS: readonly string[] = [
  // 社会科学总论 / 社会学
  '0003-1224', // American Sociological Review
  '0090-5992', // American Journal of Sociology (print 0002-9602 补充于下)
  '0002-9602', // American Journal of Sociology
  '0037-7791', // Social Forces
  '0049-089X', // Social Science Research
  '0304-2421', // Theory and Society
  '0038-0296', // Sociology
  '1469-5766', // Sociological Theory
  '0360-0025', // Public Opinion Quarterly
  '0094-3061', // Annual Review of Sociology (0360-0572 print) — 见下
  '0360-0572', // Annual Review of Sociology
  // 政治学 / 国际关系
  '0003-0554', // American Political Science Review
  '0043-8871', // World Politics
  '0092-5853', // Journal of Politics
  '0008-3970', // Comparative Politics / Comparative Political Studies(0010-4140)
  '0010-4140', // Comparative Political Studies
  '0020-8183', // International Organization（print 版）
  '0162-2889', // International Security
  '0305-7418', // International Affairs
  '1352-4658', // European Journal of International Relations
  '0022-3427', // Journal of Peace Research
  // 中国研究 / 区域研究
  '0305-7410', // The China Quarterly
  '1067-0564', // The China Journal
  '0169-7283', // Journal of Contemporary China
  '1096-3476', // Modern China
  '1369-6279', // China Information
  '1043-3865', // Post-Soviet Affairs
  // 经济学
  '0002-8282', // American Economic Review
  '0033-5533', // Quarterly Journal of Economics
  '0012-9682', // Econometrica
  '0034-6527', // Review of Economic Studies
  '0022-0515', // Journal of Economic Literature
  '0895-3309', // Journal of Economic Perspectives
  '0306-3934', // Journal of Monetary Economics
  '0165-1889', // Journal of Econometrics
  '0022-0531', // Journal of Economic Theory
  '1468-0297', // Economic Journal
  // 管理学 / 商学
  '0001-8392', // Administrative Science Quarterly
  '0001-4273', // Academy of Management Journal
  '0363-7425', // Academy of Management Review
  '0025-1909', // Management Science
  '0170-8406', // Organization Science
  '0749-5978', // Organizational Behavior and Human Decision Processes
  '0090-4848', // Organization Studies (0170-…) — 补充
  // 教育学
  '0034-6543', // Review of Educational Research
  '0002-8312', // American Educational Research Journal
  '0013-007X', // Educational Researcher (0013-189X) — 见下
  '0013-189X', // Educational Researcher
  '0957-7572', // Higher Education
  '0307-5079', // Studies in Higher Education
  // 心理学
  '0033-2909', // Psychological Bulletin
  '0033-295X', // Psychological Review
  '0956-7976', // Psychological Science
  '0066-4308', // Annual Review of Psychology
  '0022-3514', // Journal of Personality and Social Psychology
  // 历史学
  '0002-8762', // American Historical Review
  '0022-2801', // Journal of Modern History
  '0021-9118', // Journal of Asian Studies
  '0018-246X', // Historical Journal
  '0309-8343', // Past & Present (0031-2746)
  '0031-2746', // Past & Present
  // 法学
  '0017-811X', // Harvard Law Review
  '0041-9907', // Yale Law Journal (0044-0094)
  '0044-0094', // Yale Law Journal
  '0092-0617', // Stanford Law Review (0038-9765)
  '0038-9765', // Stanford Law Review
  '0021-9976', // Journal of Legal Studies
  // 新闻传播
  '0021-9916', // Journal of Communication
  '0093-6502', // Communication Research (0093-…) 
  '0165-5515', // Communication Theory (1050-3293)
  '1050-3293', // Communication Theory
  '0730-1129', // Journal of Advertising (0091-3367)
  '0091-3367', // Journal of Advertising
  // 图书情报
  '0022-0418', // Journal of Documentation
  '0740-8188', // Library & Information Science Research
  '0099-1333', // Journal of the Association for Information Science and Technology (2330-1635)
  '2330-1635', // JASIST
  // 综合 / 自然科学旗舰
  '0036-8075', // Science
  '0028-0836', // Nature
  '0027-8424', // PNAS
  '2050-084X', // eLife
  '2331-8422', // PeerJ
  // 哲学
  '0031-8119', // Philosophical Review
  '0029-4624', // Noûs
  '0031-8094', // Philosophical Quarterly
  '0026-4423', // Mind
  // ─── v2 扩充（主流 SCI/SSCI，仅收录可确信的 ISSN）───
  // 经济学
  '0022-3808', // Journal of Political Economy
  '0022-1082', // Journal of Finance
  '0893-9454', // Review of Financial Studies
  '0304-405X', // Journal of Financial Economics
  '0047-2727', // Journal of Public Economics
  '0022-1996', // Journal of International Economics
  '0734-306X', // Journal of Labor Economics
  '0094-1190', // Journal of Urban Economics
  '0741-6261', // RAND Journal of Economics
  '0899-8256', // Games and Economic Behavior
  '0305-750X', // World Development
  '0304-4076', // Journal of Development Economics
  '0013-0079', // Economic Development and Cultural Change
  '1043-951X', // China Economic Review
  '0147-5967', // Journal of Comparative Economics
  '0002-9092', // American Journal of Agricultural Economics
  // 管理学 / 商学 / 信息系统
  '0143-2095', // Strategic Management Journal
  '0022-2429', // Journal of Marketing
  '0093-5301', // Journal of Consumer Research
  '0022-2437', // Journal of Marketing Research
  '0022-4359', // Journal of Retailing
  '0272-6963', // Journal of Operations Management
  '1059-1478', // Production and Operations Management
  '1047-7047', // Information Systems Research
  '0276-7783', // MIS Quarterly
  '0742-1222', // Journal of Management Information Systems
  '0149-2063', // Journal of Management
  '0021-9010', // Journal of Applied Psychology
  '0031-5826', // Personnel Psychology
  '0047-2506', // Journal of International Business Studies
  '1042-2587', // Entrepreneurship Theory and Practice
  '0167-4544', // Journal of Business Ethics
  '1941-6520', // Academy of Management Annals
  // 政治 / 国际关系
  '1094-2939', // Annual Review of Political Science
  '1537-5927', // Perspectives on Politics
  '0022-0027', // Journal of Conflict Resolution
  '0007-1234', // British Journal of Political Science
  '0304-4130', // European Journal of Political Research
  '0963-6412', // Security Studies
  '0020-8833', // International Studies Quarterly（0020-8183 为 International Organization）
  // 社会政策 / 人口 / 健康
  '0277-9536', // Social Science & Medicine
  '0090-0036', // American Journal of Public Health
  '0022-1465', // Journal of Health and Social Behavior
  '0303-8300', // Social Indicators Research
  '0098-7921', // Population and Development Review
  '0070-3370', // Demography
  '0022-2445', // Journal of Marriage and Family
  '0378-8733', // Social Networks
  '0304-422X', // Poetics
  '0037-7732', // Social Forces（印刷版；0037-7791 为 Social Science Research）
  '0197-9183', // International Migration Review
  '1369-183X', // Journal of Ethnic and Migration Studies
  '0047-2794', // Journal of Social Policy
  // 教育
  '0742-051X', // Teaching and Teacher Education
  '0162-3737', // Educational Evaluation and Policy Analysis
  '0161-4681', // Teachers College Record
  '0022-0663', // Journal of Educational Psychology
  '0959-4752', // Learning and Instruction
  '0360-1315', // Computers & Education
  '1096-7516', // Internet and Higher Education
  '0260-2938', // Assessment & Evaluation in Higher Education
  // 心理学
  '0021-843X', // Journal of Abnormal Psychology
  '0272-7358', // Clinical Psychology Review
  '0012-1649', // Developmental Psychology
  '0010-0285', // Cognitive Psychology
  '0749-596X', // Journal of Memory and Language
  '0010-0277', // Cognition
  '0096-3445', // JEP: General
  '0033-2917', // Psychological Medicine
  // 法律 / 犯罪
  '0022-2186', // Journal of Law and Economics
  '0011-1384', // Criminology
  '0748-4518', // Journal of Quantitative Criminology
  // 传播
  '1461-4448', // New Media & Society
  '1058-4609', // Political Communication
  '1083-6101', // Journal of Computer-Mediated Communication
  // 区域 / 中国研究
  '0026-749X', // Modern Asian Studies
  '0004-4687', // Asian Survey
  '0030-851X', // Pacific Affairs
  // 环境 / 能源 / 交通（SCI-SSCI 交叉）
  '0959-3780', // Global Environmental Change
  '1462-9011', // Environmental Science & Policy
  '0264-8377', // Land Use Policy
  '0301-4797', // Journal of Environmental Management
  '0921-8009', // Ecological Economics
  '0301-4215', // Energy Policy
  '0965-8564', // Transportation Research Part A
  '0191-2615', // Transportation Research Part B
  // 综合医学 / 综合科学（方法交叉场景）
  '0140-6736', // The Lancet
  '0959-5354', // BMJ
  '0098-7484', // JAMA
  '2397-334X', // Nature Human Behaviour
  '2375-2548', // Science Advances
  // 科学计量 / 创新政策
  '0306-4573', // Information Processing & Management
  '1751-1577', // Journal of Informetrics
  '0138-9130', // Scientometrics
  '0048-7333', // Research Policy
  '0958-2029', // Research Evaluation
  // 旅游
  '0160-7383', // Annals of Tourism Research
  '0261-5177', // Tourism Management
  '0047-2875', // Journal of Travel Research
  // 经济史
  '0022-0507', // Journal of Economic History
  '0013-0117', // Economic History Review
];

/** 规范化中文期刊名：去书名号/空白，并把全角冒号、括号、间隔号、破折号等
 *  标点统一删除后匹配（NCPSSD 的 cbw_name 混用「：」「（）」「·」等格式）。 */
export function normalizeJournalName(name: string): string {
  return name.replace(/[《》\s\u3000：:（）()·．.・—―-]/gu, '').trim();
}

const chineseCoreSet = new Set(CHINESE_CORE_JOURNALS.map(normalizeJournalName));
const sciSsciIssnSet = new Set(SCI_SSCI_ISSNS.map((issn) => issn.replace(/-/g, '').toLowerCase()));

JOURNAL_LIST_STATS.chineseCoreJournals = chineseCoreSet.size;
JOURNAL_LIST_STATS.sciSsciIssns = sciSsciIssnSet.size;

/** 中文期刊是否属于核心名单（CSSCI/北大核心/CSCD 社科）。 */
export function isChineseCoreJournal(venue: string): boolean {
  return chineseCoreSet.has(normalizeJournalName(venue));
}

/** 期刊 ISSN 是否属于 SCI/SSCI 白名单。 */
export function isSciSsciIssn(issn: string | null | undefined): boolean {
  if (!issn) return false;
  return sciSsciIssnSet.has(issn.replace(/-/g, '').toLowerCase());
}

/** 运行时扩展 ISSN 白名单（用户导入官方 JCR/CSSCI 目录用）。返回新增条数。 */
export function extendSciSsciIssns(extraIssns: readonly string[]): number {
  let added = 0;
  for (const issn of extraIssns) {
    const normalized = issn.replace(/[\s-]/g, '').toLowerCase();
    if (!/^\d{7}[\dx]$/u.test(normalized)) continue;
    if (!sciSsciIssnSet.has(normalized)) {
      sciSsciIssnSet.add(normalized);
      added += 1;
    }
  }
  JOURNAL_LIST_STATS.sciSsciIssns = sciSsciIssnSet.size;
  JOURNAL_LIST_VERSION += added > 0 ? 1 : 0;
  return added;
}
