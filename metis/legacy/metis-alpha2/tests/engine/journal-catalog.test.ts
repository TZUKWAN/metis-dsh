import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  matchFieldOptions,
  parseEshukanCategories,
  parseEshukanDetail,
  parseEshukanJournalList,
  parseLetPubDetail,
  parseLetPubFieldOptions,
  parseLetPubJournalList,
  primeCatalogFieldCache,
  searchJournalCatalog,
} from '../../engine/research/JournalCatalog.js';

function loadFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/journal-catalog/${name}`, import.meta.url), 'utf8');
}

describe('LetPub catalog parsing', () => {
  it('parses the subject tree with unique field ids', () => {
    const fields = parseLetPubFieldOptions(loadFixture('letpub_fields.html'));
    expect(fields.length).toBeGreaterThan(100);
    const ids = fields.map((field) => field.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fields).toContainEqual({ id: '3', name: '生命科学' });
  });

  it('parses journal list rows with issn, id, name and abbreviation', () => {
    const list = parseLetPubJournalList(loadFixture('letpub_search.html'));
    expect(list.journals.length).toBe(10);
    const first = list.journals[0]!;
    expect(first.id).toBe('11374');
    expect(first.name).toBe('Annual Review of Sociology');
    expect(first.issn).toBe('0360-0572');
    expect(first.nameAbbr).toBe('ANNU REV SOCIOL');
    expect(first.detailUrl).toContain('journalid=11374');
  });

  it('decodes the base64 official site and keeps empty submission url absent', () => {
    const detail = parseLetPubDetail(loadFixture('letpub_detail.html'), '26098');
    expect(detail.name).toBe('Journal of Chinese Sociology');
    expect(detail.officialWebsite).toBe('http://www.journalofchinesesociology.com');
    expect(detail.submissionUrl).toBeUndefined();
    expect(detail.reviewCycle).toBe('13 Weeks');
    expect(detail.articleProcessingCharge).toBe('没有');
    expect(detail.warningStatus).toBe('不在预警名单中');
  });
});

describe('Eshukan catalog parsing', () => {
  it('parses the category tree from single-quoted anchors', () => {
    const categories = parseEshukanCategories(loadFixture('eshukan_categories.html'));
    expect(categories.length).toBeGreaterThan(100);
    expect(categories).toContainEqual({ id: '12', name: '自然科学综合' });
  });

  it('parses journal rows with the submission channel badge', () => {
    const list = parseEshukanJournalList(loadFixture('eshukan_list.html'));
    expect(list.journals.length).toBeGreaterThan(30);
    const chongqing = list.journals.find((journal) => journal.id === '25')!;
    expect(chongqing.name).toContain('重庆师范大学学报');
    expect(chongqing.submissionLabel).toBe('官网投稿');
    expect(chongqing.detailUrl).toContain('displayj.aspx?jid=25');
  });

  it('extracts submission email, url, phone and index numbers from the free-text detail', () => {
    const detail = parseEshukanDetail(loadFixture('eshukan_detail.html'), '6744');
    expect(detail.issn).toBe('1006-4362');
    expect(detail.cn).toBe('51-1467/P');
    expect(detail.submissionEmails).toContain('dzzh@cdut.edu.cn');
    expect(detail.submissionUrl).toBe('https://dzhb.cdut.edu.cn/');
    expect(detail.phone).toBe('028-84078481');
    expect(detail.submissionNotice).toBeTruthy();
  });
});

describe('field resolution', () => {
  const options = [
    { id: '1', name: '自然科学综合' },
    { id: '2', name: '社会学' },
    { id: '3', name: '人口学、劳动经济学' },
  ];

  it('matches exactly first, then by containment', () => {
    expect(matchFieldOptions(options, '社会学')).toEqual([{ id: '2', name: '社会学' }]);
    expect(matchFieldOptions(options, '劳动经济学')).toEqual([{ id: '3', name: '人口学、劳动经济学' }]);
    expect(matchFieldOptions(options, '天文学')).toEqual([]);
  });

  it('returns candidates instead of fetching when the field name is ambiguous', async () => {
    primeCatalogFieldCache('eshukan', options);
    const result = await searchJournalCatalog({ source: 'eshukan', field: '学' });
    expect(result.journals).toEqual([]);
    expect(result.fieldCandidates?.length).toBeGreaterThan(1);
    expect(result.note).toContain('多个条目');
  });

  it('asks for a field when none is provided', async () => {
    primeCatalogFieldCache('letpub', options);
    const result = await searchJournalCatalog({ source: 'letpub' });
    expect(result.journals).toEqual([]);
    expect(result.fieldCandidates).toEqual(options);
    expect(result.note).toContain('field');
  });
});
