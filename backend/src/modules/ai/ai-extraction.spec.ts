import { AIService } from './ai.service';
import { AIProcessingError } from './ai-extraction.types';

function serviceReturning(answer: any) {
  const svc: any = Object.create(AIService.prototype);
  svc.logger = { warn: () => {}, error: () => {} };
  svc.callGeminiWithTokens = async () => ({
    text: typeof answer === 'string' ? answer : JSON.stringify(answer),
    inputTokens: 10,
    outputTokens: 5,
  });
  return svc as AIService;
}

const SENT = new Date('2026-10-15T08:00:00Z'); // Thursday, 13:30 in India
const base = {
  type: 'TASK',
  title: 'Call Rahul',
  description: 'Call Rahul tomorrow at 10 AM.',
  supportingText: 'Call Rahul tomorrow at 10 AM',
  dueDate: '2026-10-16',
  dueTime: '10:00',
  originalDateText: 'tomorrow at 10 AM',
  dateCertain: true,
  priority: 'NORMAL',
  actionRequired: true,
  confidence: 0.95,
  isForCurrentUser: true,
};
const MSG = 'Call Rahul tomorrow at 10 AM, send Priya the proposal by Friday, and remind me to review the invoice next Monday.';

const extract = (answer: any, over: any = {}) =>
  serviceReturning(answer).extractItemsWithTokens({
    messageText: MSG,
    senderName: 'Amit',
    currentUserName: 'Vaibhav',
    messageTimestamp: SENT,
    chatKind: 'direct',
    ...over,
  });

describe('extraction: items from one message', () => {
  it('one action creates one item', async () => {
    const r = await extract({ items: [base], updates: [] });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].eventDate).toBe('2026-10-16');
    expect(r.items[0].eventTime).toBe('10:00');
  });

  it('three actions create three separate items with different keys', async () => {
    const r = await extract({
      items: [
        base,
        { ...base, title: 'Send proposal to Priya', supportingText: 'send Priya the proposal by Friday', dueDate: '2026-10-16', dueTime: null, originalDateText: 'by Friday' },
        { ...base, type: 'REMINDER', title: 'Review the invoice', supportingText: 'remind me to review the invoice next Monday', dueDate: '2026-10-19', dueTime: null, originalDateText: 'next Monday' },
      ],
    });
    expect(r.items).toHaveLength(3);
    expect(new Set(r.items.map((i) => i.itemKey)).size).toBe(3);
  });

  it('two items of the SAME type in one message are both kept', async () => {
    const r = await extract({
      items: [base, { ...base, title: 'Send proposal to Priya', supportingText: 'send Priya the proposal by Friday' }],
    });
    expect(r.items).toHaveLength(2);
  });

  it('the same item returned twice is stored once', async () => {
    const r = await extract({ items: [base, { ...base }] });
    expect(r.items).toHaveLength(1);
  });

  it('normal chat produces nothing', async () => {
    const r = await extract({ items: [], updates: [] }, { messageText: 'Hi, thanks!' });
    expect(r.items).toHaveLength(0);
  });

  it('drops items whose supporting text is not in the message (invented)', async () => {
    const r = await extract({ items: [{ ...base, supportingText: 'Pay 90000 rupees tomorrow' }] });
    expect(r.items).toHaveLength(0);
  });

  it('drops low-confidence items and unknown types', async () => {
    expect((await extract({ items: [{ ...base, confidence: 0.5 }] })).items).toHaveLength(0);
    expect((await extract({ items: [{ ...base, type: 'JOKE' }] })).items).toHaveLength(0);
  });

  it('keeps an ambiguous date as text and does not invent a deadline', async () => {
    const r = await extract(
      { items: [{ ...base, dueDate: '2026-10-22', dueTime: null, dateCertain: false, originalDateText: 'sometime next week' }] },
      {}
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0].eventDate).toBeNull();
    expect(r.items[0].dateUncertain).toBe(true);
    expect(r.items[0].originalDateText).toBe('sometime next week');
  });

  it('drops a meeting with neither a date nor any date wording', async () => {
    const r = await extract({
      items: [{ ...base, type: 'MEETING', dueDate: null, dueTime: null, originalDateText: null, supportingText: 'Call Rahul' }],
    });
    expect(r.items).toHaveLength(0);
  });

  it('drops a payment without an amount', async () => {
    const r = await extract({
      items: [{ ...base, type: 'PAYMENT', supportingText: 'Call Rahul', entities: { amounts: [] } }],
    });
    expect(r.items).toHaveLength(0);
  });

  it('keeps a payment with an amount', async () => {
    const r = await extract({
      items: [{ ...base, type: 'PAYMENT', title: 'Fees', supportingText: 'Call Rahul', entities: { amounts: ['Rs 5000'] } }],
    });
    expect(r.items).toHaveLength(1);
  });

  it('ignores model-supplied ids and tenant fields', async () => {
    const r = await extract({ items: [{ ...base, id: 'evil', userId: 'someone-else', messageId: 'x' }] });
    expect(r.items[0]).not.toHaveProperty('id');
    expect(r.items[0]).not.toHaveProperty('userId');
  });

  it('in a group only keeps items clearly for the user', async () => {
    const maybe = { ...base, isForCurrentUser: undefined };
    const noGroup = await extract({ items: [maybe] }, { groupName: 'Team', chatKind: null });
    const yesGroup = await extract({ items: [{ ...base, isForCurrentUser: true }] }, { groupName: 'Team', chatKind: null });
    const direct = await extract({ items: [maybe] });
    expect(noGroup.items).toHaveLength(0);
    expect(yesGroup.items).toHaveLength(1);
    expect(direct.items).toHaveLength(1);
  });
});

describe('extraction: birthdays', () => {
  const wish = 'Happy birthday Rahul!! have a great year';
  const bday = {
    type: 'BIRTHDAY',
    title: "Rahul's birthday",
    description: 'Group wished Rahul.',
    supportingText: 'Happy birthday Rahul',
    dueDate: null,
    confidence: 0.95,
    birthdayPerson: 'Rahul',
    isForCurrentUser: false,
  };

  it('keeps a group birthday for someone else, dated to the day it was sent (India time)', async () => {
    const late = new Date('2026-10-15T20:00:00Z'); // 01:30 on the 16th in India
    const r = await extract({ items: [bday] }, { messageText: wish, groupName: 'Friends', chatKind: null, messageTimestamp: late });
    expect(r.items[0].extractionType).toBe('BIRTHDAY');
    expect(r.items[0].eventDate).toBe('2026-10-16');
    expect(r.items[0].targetPerson).toBe('Rahul');
    expect(r.items[0].isForCurrentUser).toBe(false);
  });

  it('marks a birthday wish for the user', async () => {
    const r = await extract(
      { items: [{ ...bday, birthdayPerson: 'Vaibhav', supportingText: 'Happy birthday Vaibhav' }] },
      { messageText: 'Happy birthday Vaibhav' }
    );
    expect(r.items[0].isForCurrentUser).toBe(true);
  });

  it('keeps a group birthday wish even when the person is not named', async () => {
    for (const person of [null, 'sir', 'lord', '@127831229104315', 'everyone']) {
      const r = await extract({ items: [{ ...bday, birthdayPerson: person }] }, { messageText: wish, groupName: 'MCA', chatKind: null });
      expect(r.items).toHaveLength(1);
      expect(r.items[0].targetPerson).toBeNull();
      expect(r.items[0].isForCurrentUser).toBe(false);
    }
  });
});

describe('extraction: updates to saved items', () => {
  const open = [
    { ref: 'E1', id: 'id-call', type: 'TASK', title: 'Call Rahul', dueAt: new Date('2026-10-16') },
    { ref: 'E2', id: 'id-prop', type: 'TASK', title: 'Send proposal', dueAt: null },
  ];
  const upd = {
    target: 'E1',
    action: 'RESCHEDULE',
    newDueDate: '2026-10-16',
    newDueTime: '11:00',
    supportingText: "Move Rahul's call to 11 AM",
    confidence: 0.95,
  };
  const run = (u: any) =>
    extract({ items: [], updates: [u] }, { messageText: "Move Rahul's call to 11 AM.", openItems: open });

  it('maps a clear reference to the real item id', async () => {
    const r = await run(upd);
    expect(r.updates).toEqual([expect.objectContaining({ targetId: 'id-call', action: 'RESCHEDULE', newEventTime: '11:00' })]);
  });

  it('ignores references to items that were not offered', async () => {
    expect((await run({ ...upd, target: 'E9' })).updates).toHaveLength(0);
    expect((await run({ ...upd, target: 'id-call' })).updates).toHaveLength(0);
  });

  it('ignores low-confidence or unsupported changes', async () => {
    expect((await run({ ...upd, confidence: 0.6 })).updates).toHaveLength(0);
    expect((await run({ ...upd, supportingText: 'cancel everything' })).updates).toHaveLength(0);
    expect((await run({ ...upd, action: 'DELETE' })).updates).toHaveLength(0);
  });
});

describe('extraction: failures are not silent', () => {
  it('invalid JSON throws a retryable INVALID_RESPONSE error', async () => {
    await expect(extract('this is not json')).rejects.toMatchObject({ category: 'INVALID_RESPONSE', retryable: true });
  });

  it('a cut-off response says so', async () => {
    const svc: any = Object.create(AIService.prototype);
    svc.callGeminiWithTokens = async () => ({ text: '{"items": [{"type":"TA', inputTokens: 1, outputTokens: 1, truncated: true });
    await expect(svc.extractItemsWithTokens({ messageText: 'x', senderName: 'A' })).rejects.toThrow(/cut off/);
  });

  it('a response without an items list is rejected', async () => {
    await expect(extract({ hello: 'world' })).rejects.toBeInstanceOf(AIProcessingError);
  });

  it('provider errors propagate instead of becoming "nothing found"', async () => {
    const svc: any = Object.create(AIService.prototype);
    svc.callGeminiWithTokens = async () => {
      throw new AIProcessingError('timed out', 'PROVIDER_TIMEOUT');
    };
    await expect(svc.extractItemsWithTokens({ messageText: 'x', senderName: 'A' })).rejects.toMatchObject({
      category: 'PROVIDER_TIMEOUT',
    });
  });
});

describe('suggested reply is strict', () => {
  it('returns one short, confident reply', async () => {
    const svc = serviceReturning([{ text: 'Yes, I will come at 5', language: 'en', confidence: 0.92 }]);
    const r = await svc.generateReplySuggestionsWithTokens('Will you come at 5?', 'Amit', null, 'Vaibhav', []);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].text).toBe('Yes, I will come at 5');
  });

  it('returns nothing when the model says no reply is needed', async () => {
    const r = await serviceReturning([]).generateReplySuggestionsWithTokens('Happy birthday!', 'Amit', null, 'Vaibhav', []);
    expect(r.items).toHaveLength(0);
  });

  it('drops low-confidence and overlong replies', async () => {
    const low = await serviceReturning([{ text: 'Maybe', language: 'en', confidence: 0.5 }])
      .generateReplySuggestionsWithTokens('Are you free?', 'Amit', null, 'Vaibhav', []);
    const long = await serviceReturning([{ text: 'x'.repeat(250), language: 'en', confidence: 0.95 }])
      .generateReplySuggestionsWithTokens('Are you free?', 'Amit', null, 'Vaibhav', []);
    expect(low.items).toHaveLength(0);
    expect(long.items).toHaveLength(0);
  });

  it('never suggests a reply that names the group', async () => {
    const r = await serviceReturning([{ text: 'Yes in Placement Drive group', language: 'en', confidence: 0.95 }])
      .generateReplySuggestionsWithTokens('Who is coming?', 'Amit', 'Placement Drive', 'Vaibhav', []);
    expect(r.items).toHaveLength(0);
  });
});

describe('pre-filters', () => {
  const svc = serviceReturning([]) as any;
  it('skips normal chat before any model call', () => {
    for (const t of ['kya kar raha hai', 'ha bhai theek hai', 'lol that was funny', 'aaj mast din tha', 'Hi, thanks!'])
      expect(svc.hasExtractionSignal(t)).toBe(false);
  });
  it('lets tasks, events and birthdays through', () => {
    for (const t of [
      'Happy birthday Rahul',
      'meeting tomorrow at 5pm',
      'pay Rs 5000 by 20 Oct',
      'वाढदिवसाच्या शुभेच्छा',
      'Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.',
      'Also remind me to review the invoice next Monday.',
      "Move Rahul's call to 11 AM.",
      'The proposal has been sent.',
    ])
      expect(svc.hasExtractionSignal(t)).toBe(true);
  });
  it('blocks ads, job drives, flat listings and channel invitations', () => {
    for (const t of [
      'Loot @399 : https://www.amazon.in/dp/B0HMHYXSWZ Regular Price 1999',
      'Join WhatsApp for Daily Fresher Job Updates https://chat.whatsapp.com/abc',
      'Top tech Hiring Drive 2026 apply now before 20 Oct',
      '4 Male flatmates required 2 bhk, pay Rs 7000 by 1st',
      'Tomorrow Special Session on Current Affairs at 7 pm, register now',
    ])
      expect(svc.hasExtractionSignal(t)).toBe(false);
  });
  it('never blocks a birthday wish or a real personal request', () => {
    expect(svc.hasExtractionSignal('Happy birthday Rahul! join us at 7 for the party')).toBe(true);
    expect(svc.hasExtractionSignal('Call me tomorrow at 10 about the invoice')).toBe(true);
    expect(svc.looksPromotional('Call me tomorrow at 10 about the invoice')).toBe(false);
  });
  it('bulk scans ignore casual chat that merely contains call or send', () => {
    for (const t of ['Call var tari bola', 'Mala vatla ata tari call karshil te pan nahi', 'send kar na'])
      expect(svc.hasStrongSignal(t)).toBe(false);
    for (const t of ['meeting tomorrow at 5pm', 'Happy birthday Rahul', 'pay Rs 5000 for fees', 'Call Rahul tomorrow at 10 AM'])
      expect(svc.hasStrongSignal(t)).toBe(true);
  });
  it('only suggests replies for questions and requests', () => {
    expect(svc.needsReplySignal('tu aala ka?')).toBe(true);
    expect(svc.needsReplySignal('report bhej de')).toBe(true);
    expect(svc.needsReplySignal('ok')).toBe(false);
    expect(svc.needsReplySignal('mast tha aaj')).toBe(false);
  });
});

describe('Hinglish / Marathi plans and listings', () => {
  const svc = serviceReturning([]) as any;
  it('detects times and dates written the Indian way', () => {
    for (const t of ['kal 5 baje office aana', 'udya 10 vajta meeting ahe', 'Aaj raat 8 baje party hai Rahul ke ghar', 'rent 5000 bhej dena 5 tarikh tak', 'exam 20 tarikh ko hai']) {
      expect(svc.hasExtractionSignal(t)).toBe(true);
      expect(svc.hasStrongSignal(t)).toBe(true);
    }
  });
  it('still ignores plain plans without a time', () => {
    expect(svc.hasExtractionSignal('lunch kal karuya ka')).toBe(false);
  });
  it('blocks flat and room listings and automated class reminders', () => {
    for (const t of [
      '2 BHK SEMI-FURNISHED FLAT FOR RENT (NO BROKERAGE)',
      'Urgent... 1 GIRL Needed Urgently 1 BHK',
      'रूम पार्टनर हवा आहे ₹3375',
      'Reminder: 30 Mins To Go!! You have a Day 1 class scheduled',
    ])
      expect(svc.hasExtractionSignal(t)).toBe(false);
  });
});
