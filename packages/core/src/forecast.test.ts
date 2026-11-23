import { describe, expect, it } from 'vitest';
import { flaggedPeriods, forecastConcerns, forecastUrlFromPoint, parseForecast } from './forecast';
import { planForecastHeadsUps, type ContactInput, type RuleInput } from './rules';

const period = (o: Record<string, unknown> = {}) => ({
  number: 1,
  name: 'Today',
  startTime: '2026-11-23T10:00:00-08:00',
  endTime: '2026-11-23T18:00:00-08:00',
  isDaytime: true,
  temperature: 48,
  temperatureUnit: 'F',
  probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 63 },
  windSpeed: '6 mph',
  windDirection: 'SE',
  shortForecast: 'Light Rain Likely',
  detailedForecast: 'Rain likely. Cloudy. High near 48. Southeast wind around 6 mph.',
  ...o,
});

describe('NWS point forecast', () => {
  it('takes the forecast address from a /points reply only when it is a Weather Service gridpoint', () => {
    expect(forecastUrlFromPoint({ properties: { forecast: 'https://api.weather.gov/gridpoints/SEW/96,55/forecast' } })).toBe('https://api.weather.gov/gridpoints/SEW/96,55/forecast');
    expect(forecastUrlFromPoint({ properties: { forecast: 'https://evil.example/gridpoints/SEW/96,55/forecast' } })).toBeNull();
    expect(forecastUrlFromPoint({ properties: { forecast: 'https://api.weather.gov/gridpoints/SEW/96,55/forecast/../../x' } })).toBeNull();
    expect(forecastUrlFromPoint({ properties: {} })).toBeNull();
    expect(forecastUrlFromPoint(null)).toBeNull();
  });

  it('reads periods, limits how many, and skips malformed ones', () => {
    const periods = parseForecast({ properties: { periods: [period(), { name: 'Broken' }, ...Array.from({ length: 10 }, (_, i) => period({ name: `P${i}` }))] } });
    expect(periods).toHaveLength(6);
    expect(periods[0]).toMatchObject({ name: 'Today', isDaytime: true, temperature: 48, temperatureUnit: 'F', precipChance: 63, wind: 'SE 6 mph', shortForecast: 'Light Rain Likely', concerns: [] });
    expect(periods[1]!.name).toBe('P0');
    expect(parseForecast({ properties: { periods: [period({ probabilityOfPrecipitation: { value: null }, temperature: null })] } })[0]).toMatchObject({ precipChance: null, temperature: null });
    expect(parseForecast({})).toEqual([]);
    expect(parseForecast(null)).toEqual([]);
  });

  it('flags periods that deserve a second look, and leaves ordinary weather alone', () => {
    const c = (shortForecast: string, detailedForecast = '', wind = 'S 5 mph') => forecastConcerns({ shortForecast, detailedForecast, wind });
    expect(c('Light Rain Likely', 'Rain likely. Cloudy.')).toEqual([]);
    expect(c('Sunny', 'Sunny, with a high near 70. A nice day.')).toEqual([]);
    expect(c('Showers And Thunderstorms', 'Some storms could produce heavy rain.')).toEqual(['Thunderstorms', 'Heavy rain']);
    expect(c('Heavy Snow', 'Snow accumulation of 6 to 10 inches.')).toEqual(['Snow']);
    expect(c('Rain', 'Rain. Snow level 3500 feet.')).toEqual([]);
    expect(c('Freezing Rain', 'Ice accumulation of a tenth of an inch.')).toEqual(['Ice']);
    expect(c('Tropical Storm Conditions Possible')).toEqual(['Severe weather possible']);
    expect(c('Mostly Cloudy', '', 'W 20 to 35 mph')).toEqual(['Strong wind']);
    expect(c('Breezy', 'West wind 15 to 25 mph, with gusts as high as 45 mph.', 'W 15 to 25 mph')).toEqual(['Strong wind']);
    expect(c('Breezy', 'West wind 15 to 25 mph, with gusts as high as 35 mph.', 'W 15 to 25 mph')).toEqual([]);
  });
});

describe('forecast heads-ups', () => {
  it('keeps flagged periods that start within two days and have not ended', () => {
    const now = new Date('2026-11-23T20:00:00Z'); // noon Pacific
    const storm = { shortForecast: 'Thunderstorms', detailedForecast: '' };
    const periods = parseForecast(
      { properties: { periods: [
        period({ name: 'Overnight', startTime: '2026-11-23T00:00:00-08:00', endTime: '2026-11-23T06:00:00-08:00', ...storm }),
        period({ name: 'Today', ...storm }),
        period({ name: 'Tonight', startTime: '2026-11-23T18:00:00-08:00', endTime: '2026-11-24T06:00:00-08:00' }),
        period({ name: 'Wednesday', startTime: '2026-11-25T06:00:00-08:00', endTime: '2026-11-25T18:00:00-08:00', ...storm }),
        period({ name: 'Friday', startTime: '2026-11-27T06:00:00-08:00', endTime: '2026-11-27T18:00:00-08:00', ...storm }),
      ] } },
      14,
    );
    expect(flaggedPeriods(periods, now).map((p) => [p.name, p.day, p.concerns])).toEqual([
      ['Today', '2026-11-23', ['Thunderstorms']],
      ['Wednesday', '2026-11-25', ['Thunderstorms']],
    ]);
  });

  const rule = (o: Partial<RuleInput> = {}): RuleInput => ({
    id: 'r1', organizationId: 'o1', enabled: true, hazardTypes: ['hail'], minSeverity: 'extreme', scope: 'all', clientIds: [], propertyIds: [],
    recipientMode: 'linked', contactIds: [], channels: ['email', 'sms'], forecastHeadsUp: true, ...o,
  });
  const contact = (o: Partial<ContactInput> = {}): ContactInput => ({ id: 'k1', organizationId: 'o1', clientId: 'c1', propertyIds: [], email: 'a@example.test', mobile: null, smsOptIn: false, ...o });
  const place = (propertyId: string, clientId = 'c1') => ({ propertyId, clientId, organizationId: 'o1', items: [{ day: '2026-11-25', concern: 'Thunderstorms' }] });

  it('plans one message per contact and never repeats what was already sent', () => {
    const plans = planForecastHeadsUps({ rules: [rule()], flagged: [place('p1'), place('p2')], contacts: [contact()], alreadySent: new Set(['k1|p1|Thunderstorms|2026-11-25']) });
    expect(plans).toEqual([{ organizationId: 'o1', contactId: 'k1', ruleId: 'r1', items: [{ propertyId: 'p2', day: '2026-11-25', concern: 'Thunderstorms' }] }]);
  });

  it('ignores rules that did not ask, are off, or do not cover the location, and contacts with no email or from another organization', () => {
    const flagged = [place('p1'), place('p9', 'c2')];
    const run = (rules: RuleInput[], contacts = [contact()]) => planForecastHeadsUps({ rules, flagged, contacts, alreadySent: new Set() });
    expect(run([rule({ forecastHeadsUp: false })])).toEqual([]);
    expect(run([rule({ enabled: false })])).toEqual([]);
    expect(run([rule({ scope: 'clients', clientIds: ['c3'] })])).toEqual([]);
    expect(run([rule()], [contact({ email: null })])).toEqual([]);
    expect(run([rule()], [contact({ organizationId: 'o2' })])).toEqual([]);
    // A linked contact only hears about their own client's locations.
    expect(run([rule()])[0]!.items.map((i) => i.propertyId)).toEqual(['p1']);
    // Two rules covering the same contact still produce one message with each item once.
    expect(run([rule(), rule({ id: 'r2' })])).toHaveLength(1);
    expect(run([rule(), rule({ id: 'r2' })])[0]!.items).toHaveLength(1);
    // A rule naming specific contacts reaches them whatever client they belong to.
    expect(run([rule({ recipientMode: 'specific', contactIds: ['k1'] })])[0]!.items.map((i) => i.propertyId)).toEqual(['p1', 'p9']);
  });
});
