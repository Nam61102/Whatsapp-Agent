import {
  contactScore,
  isHumanName,
  isLidJid,
  lidId,
  nextContactName,
  phoneKey,
  pickBestContact,
} from './contact-name-policy';

describe('phoneKey', () => {
  it('matches the same person across number formats', () => {
    expect(phoneKey('+91 70305 13050')).toBe('7030513050');
    expect(phoneKey('917030513050')).toBe('7030513050');
    expect(phoneKey('7030513050@s.whatsapp.net')).toBe('7030513050');
    expect(phoneKey('917030513050:12@s.whatsapp.net')).toBe('7030513050');
  });

  it('ignores identifiers too short to be a phone number', () => {
    expect(phoneKey('12345')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });
});

describe('LID handling', () => {
  it('never turns a LID into a phone key', () => {
    expect(phoneKey('217256709591222@lid')).toBeNull();
    expect(phoneKey('217256709591222:3@lid')).toBeNull();
  });

  it('recognises LID jids and gives the same id with or without the suffix', () => {
    expect(isLidJid('217256709591222@lid')).toBe(true);
    expect(isLidJid('917030513050@s.whatsapp.net')).toBe(false);
    expect(lidId('217256709591222@lid')).toBe('217256709591222');
    expect(lidId('217256709591222')).toBe('217256709591222');
  });
});

describe('isHumanName', () => {
  it('accepts emoji-decorated saved names exactly as the user wrote them', () => {
    expect(isHumanName('💗 Ñ😊mr😊t😊 💗')).toBe(true);
    expect(isHumanName('Namrata Kadam')).toBe(true);
  });

  it('rejects placeholders, raw ids and bare numbers', () => {
    expect(isHumanName('Contact')).toBe(false);
    expect(isHumanName('WhatsApp Contact')).toBe(false);
    expect(isHumanName('917030513050')).toBe(false);
    expect(isHumanName('+917030513050')).toBe(false);
    expect(isHumanName('917030513050@s.whatsapp.net')).toBe(false);
    expect(isHumanName('   ')).toBe(false);
  });
});

describe('pickBestContact', () => {
  const saved = {
    displayName: 'Namrata Kadam',
    isSavedContact: true,
    phoneNumber: '+917030513050',
  };
  const pushOnly = {
    displayName: '💗 Ñ😊mr😊t😊 💗',
    isSavedContact: false,
    phoneNumber: '+917030513050',
  };

  it('prefers the saved phonebook row over a push-name row', () => {
    expect(pickBestContact([pushOnly, saved])).toBe(saved);
    expect(pickBestContact([saved, pushOnly])).toBe(saved);
  });

  it('gives the same winner no matter the row order', () => {
    const rows = [pushOnly, saved, { displayName: '917030513050', isSavedContact: false }];
    expect(pickBestContact(rows)).toBe(saved);
    expect(pickBestContact([...rows].reverse())).toBe(saved);
  });

  it('returns undefined for an empty list', () => {
    expect(pickBestContact([])).toBeUndefined();
  });

  it('scores a saved, named row above an unsaved one', () => {
    expect(contactScore(saved)).toBeGreaterThan(contactScore(pushOnly));
  });
});

describe('nextContactName (write rule)', () => {
  const saved = { displayName: 'Namrata Kadam', isSavedContact: true };

  it('never replaces a saved name with a push name', () => {
    const r = nextContactName(saved, { name: '💗 Ñ😊mr😊t😊 💗', isSaved: false });
    expect(r.displayName).toBe('Namrata Kadam');
    expect(r.isSavedContact).toBe(true);
  });

  it('keeps the saved flag when a later sync omits the address-book name', () => {
    const r = nextContactName(saved, { name: undefined, isSaved: false });
    expect(r.isSavedContact).toBe(true);
    expect(r.displayName).toBe('Namrata Kadam');
  });

  it('lets a saved name replace an earlier push name', () => {
    const r = nextContactName({ displayName: 'Johnny', isSavedContact: false }, { name: 'John Doe', isSaved: true });
    expect(r).toEqual({ displayName: 'John Doe', isSavedContact: true });
  });

  it('lets an unsaved contact update its push name', () => {
    const r = nextContactName({ displayName: 'Old Push', isSavedContact: false }, { name: 'New Push', isSaved: false });
    expect(r).toEqual({ displayName: 'New Push', isSavedContact: false });
  });

  it('creates a new unsaved contact from a push name', () => {
    expect(nextContactName(null, { name: 'Ravi', isSaved: false })).toEqual({
      displayName: 'Ravi',
      isSavedContact: false,
    });
  });

  it('does not store raw numbers as the name', () => {
    const r = nextContactName({ displayName: 'Ravi', isSavedContact: false }, { name: '917030513050', isSaved: false });
    expect(r.displayName).toBe('Ravi');
  });
});
