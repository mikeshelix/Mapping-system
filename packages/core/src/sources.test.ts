import { describe, expect, it } from 'vitest';
import {
  convectiveDay,
  cycloneSeverity,
  earthquakeRadiusMeters,
  earthquakeSeverity,
  femaSeverity,
  firmsSeverity,
  gaugeSeverity,
  hailSeverity,
  parseFemaDeclarations,
  parseFirmsCsv,
  parseNhcStorm,
  parseRiverGauges,
  parseSpcReports,
  parseUsgsEarthquakes,
  parseWfigsPerimeters,
  renderHazardSms,
  normalizeUsPhone,
  classifyInboundSms,
  tornadoSeverity,
  wildfireSeverity,
  windFieldSeverity,
  windSeverity,
  type FemaRow,
} from './index';

describe('severity mapping per source', () => {
  it('hail size', () => {
    expect(hailSeverity(0.75)).toBe('minor');
    expect(hailSeverity(0.99)).toBe('minor');
    expect(hailSeverity(1.0)).toBe('moderate');
    expect(hailSeverity(1.74)).toBe('moderate');
    expect(hailSeverity(1.75)).toBe('severe');
    expect(hailSeverity(2.74)).toBe('severe');
    expect(hailSeverity(2.75)).toBe('extreme');
    expect(hailSeverity(0)).toBe('unknown');
    expect(hailSeverity(NaN)).toBe('unknown');
  });

  it('wind speed', () => {
    expect(windSeverity(null)).toBe('moderate'); // damage reported, speed unknown
    expect(windSeverity(50)).toBe('minor');
    expect(windSeverity(58)).toBe('moderate');
    expect(windSeverity(74)).toBe('moderate');
    expect(windSeverity(75)).toBe('severe');
    expect(windSeverity(100)).toBe('extreme');
  });

  it('tornado rating', () => {
    expect(tornadoSeverity(null)).toBe('severe');
    expect(tornadoSeverity('UNK')).toBe('severe');
    expect(tornadoSeverity('EF0')).toBe('severe');
    expect(tornadoSeverity('EF1')).toBe('severe');
    expect(tornadoSeverity('EF2')).toBe('extreme');
    expect(tornadoSeverity('EF5')).toBe('extreme');
  });

  it('earthquake magnitude, raised by a PAGER alert', () => {
    expect(earthquakeSeverity(3.9)).toBe('minor');
    expect(earthquakeSeverity(4.0)).toBe('moderate');
    expect(earthquakeSeverity(5.0)).toBe('severe');
    expect(earthquakeSeverity(6.0)).toBe('extreme');
    expect(earthquakeSeverity(null)).toBe('unknown');
    expect(earthquakeSeverity(4.2, 'green')).toBe('moderate');
    expect(earthquakeSeverity(4.2, 'yellow')).toBe('severe');
    expect(earthquakeSeverity(4.2, 'red')).toBe('extreme');
    expect(earthquakeRadiusMeters(3.5)).toBe(15_000);
    expect(earthquakeRadiusMeters(6.4)).toBe(200_000);
  });

  it('tropical cyclone intensity and wind fields', () => {
    expect(cycloneSeverity(30)).toBe('minor');
    expect(cycloneSeverity(34)).toBe('moderate');
    expect(cycloneSeverity(64)).toBe('severe');
    expect(cycloneSeverity(96)).toBe('extreme');
    expect(cycloneSeverity(null)).toBe('unknown');
    expect(windFieldSeverity(34)).toBe('moderate');
    expect(windFieldSeverity(50)).toBe('severe');
    expect(windFieldSeverity(64)).toBe('extreme');
  });

  it('wildfire size and containment', () => {
    expect(wildfireSeverity(50, null)).toBe('moderate');
    expect(wildfireSeverity(500, 0)).toBe('severe');
    expect(wildfireSeverity(20_000, 10)).toBe('extreme');
    expect(wildfireSeverity(20_000, 60)).toBe('severe'); // half contained: one level lower
    expect(wildfireSeverity(50, 60)).toBe('minor');
    expect(wildfireSeverity(250_000, 100)).toBe('minor'); // contained
  });

  it('satellite fire detection confidence', () => {
    expect(firmsSeverity('l')).toBe('minor');
    expect(firmsSeverity('n')).toBe('moderate');
    expect(firmsSeverity('h')).toBe('severe');
    expect(firmsSeverity('85')).toBe('severe'); // MODIS percent
    expect(firmsSeverity('20')).toBe('minor');
    expect(firmsSeverity('')).toBe('unknown');
  });

  it('river gauge flood category', () => {
    expect(gaugeSeverity('action')).toBe('minor');
    expect(gaugeSeverity('minor')).toBe('moderate');
    expect(gaugeSeverity('moderate')).toBe('severe');
    expect(gaugeSeverity('major')).toBe('extreme');
    expect(gaugeSeverity('no_flooding')).toBe('unknown');
  });

  it('FEMA declaration type', () => {
    expect(femaSeverity('DR')).toBe('severe');
    expect(femaSeverity('EM')).toBe('moderate');
    expect(femaSeverity('FM')).toBe('moderate');
    expect(femaSeverity('XX')).toBe('unknown');
  });
});

describe('SPC storm reports', () => {
  it('uses the 12 UTC convective day', () => {
    expect(convectiveDay(new Date('2026-05-10T11:59:00Z'))).toBe('2026-05-09');
    expect(convectiveDay(new Date('2026-05-10T12:00:00Z'))).toBe('2026-05-10');
  });

  it('parses hail reports, with times after midnight on the next calendar day', () => {
    const csv = [
      'Time,Size,Location,County,State,Lat,Lon,Comments',
      '1955,175,3 W OAKLEY,LOGAN,KS,39.13,-100.91,GOLF BALL HAIL (GLD)',
      '0130,100,"SPRINGFIELD, DOWNTOWN",GREENE,MO,37.21,-93.29,QUARTER SIZE',
    ].join('\n');
    const [a, b] = parseSpcReports(csv, 'hail', '2026-05-10');
    expect(a).toMatchObject({ source: 'spc', hazardType: 'hail', severity: 'severe', eventName: 'Hail report: 1.75 in', point: { lon: -100.91, lat: 39.13 } });
    expect(a!.startsAt).toBe('2026-05-10T19:55:00.000Z');
    expect(a!.key).toBe('hail:2026-05-10:1955:39.13:-100.91');
    expect(b).toMatchObject({ severity: 'moderate' });
    expect(b!.startsAt).toBe('2026-05-11T01:30:00.000Z');
    expect(b!.areaDesc).toContain('SPRINGFIELD, DOWNTOWN');
  });

  it('parses wind and tornado reports', () => {
    const wind = parseSpcReports('Time,Speed,Location,County,State,Lat,Lon,Comments\n2100,UNK,X,Y,TX,31,-97,TREES DOWN\n2110,82,X,Y,TX,31.1,-97,MEASURED', 'wind', '2026-05-10');
    expect(wind.map((e) => [e.eventName, e.severity])).toEqual([
      ['Wind damage report', 'moderate'],
      ['Wind report: 82 mph', 'severe'],
    ]);
    const torn = parseSpcReports('Time,F_Scale,Location,County,State,Lat,Lon,Comments\n2200,UNK,X,Y,OK,35,-97,BRIEF TOUCHDOWN\n2230,EF3,X,Y,OK,35.2,-97,', 'torn', '2026-05-10');
    expect(torn.map((e) => [e.hazardType, e.severity])).toEqual([
      ['tornado', 'severe'],
      ['tornado', 'extreme'],
    ]);
  });

  it('returns nothing for a header-only file and skips rows without coordinates', () => {
    expect(parseSpcReports('Time,Size,Location,County,State,Lat,Lon,Comments\n', 'hail', '2026-05-10')).toEqual([]);
    expect(parseSpcReports('Time,Size,Location,County,State,Lat,Lon,Comments\n1900,100,X,Y,KS,,,', 'hail', '2026-05-10')).toEqual([]);
  });
});

describe('other sources', () => {
  it('USGS: keeps earthquakes only, with a magnitude-based radius', () => {
    const events = parseUsgsEarthquakes({
      features: [
        { id: 'us1', geometry: { coordinates: [-118.2, 34.1, 10] }, properties: { mag: 5.4, place: 'Los Angeles', time: 1_700_000_000_000, alert: null, type: 'earthquake', url: 'u' } },
        { id: 'us2', geometry: { coordinates: [-100, 40, 0] }, properties: { mag: 3, place: 'x', time: 1, alert: null, type: 'quarry blast', url: 'u' } },
        { id: 'us3', geometry: { coordinates: [-100, 40, 0] }, properties: { mag: null, place: 'x', time: 1, alert: null, type: 'earthquake', url: 'u' } },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: 'us1', severity: 'severe', radiusMeters: 100_000, point: { lon: -118.2, lat: 34.1 }, eventName: 'Magnitude 5.4 earthquake' });
  });

  it('NHC: one cone event plus non-overlapping wind bands, strongest first', () => {
    const poly = (n: number) => ({ type: 'Polygon', coordinates: [[[0, 0], [n, 0], [n, n], [0, n], [0, 0]]] });
    const events = parseNhcStorm(
      { id: 'al012026', binNumber: 'AT1', name: 'Ana', classification: 'HU', intensity: '100' },
      [{ geometry: poly(20), properties: {} }],
      [
        { geometry: poly(6), properties: { radii: 34 } },
        { geometry: poly(2), properties: { radii: 64 } },
        { geometry: poly(4), properties: { radii: 50 } },
      ],
    );
    expect(events.map((e) => [e.key, e.severity, e.subtract?.length ?? 0])).toEqual([
      ['al012026:cone', 'extreme', 0],
      ['al012026:wind64', 'extreme', 0],
      ['al012026:wind50', 'severe', 1],
      ['al012026:wind34', 'moderate', 2],
    ]);
    expect(events[0]!.eventName).toBe('Hurricane Ana: forecast cone');
  });

  it('WFIGS: skips prescribed burns and reads size and containment', () => {
    const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const events = parseWfigsPerimeters([
      { geometry, properties: { poly_IRWINID: '{ABC}', attr_IncidentName: 'Ranger Road', poly_GISAcres: 278898.8, attr_PercentContained: 100, attr_IncidentTypeCategory: 'WF', attr_POOState: 'US-OK' } },
      { geometry, properties: { poly_IRWINID: '{RX1}', attr_IncidentName: 'RX Buck Creek', poly_GISAcres: 805, attr_PercentContained: null, attr_IncidentTypeCategory: 'RX' } },
      { geometry, properties: { poly_IRWINID: '{DEF}', attr_IncidentName: 'Pine', poly_GISAcres: 6000, attr_PercentContained: 5, attr_IncidentTypeCategory: 'WF' } },
    ]);
    expect(events.map((e) => [e.key, e.eventName, e.severity])).toEqual([
      ['ABC', 'Ranger Road Fire', 'minor'],
      ['DEF', 'Pine Fire', 'extreme'],
    ]);
  });

  it('FIRMS: reads columns by name', () => {
    const csv = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n34.1234,-118.5432,340,0.4,0.4,2026-11-10,915,N20,VIIRS,h,2.0NRT,290,12.5,N\n';
    const [e] = parseFirmsCsv(csv, 'VIIRS_NOAA20_NRT');
    expect(e).toMatchObject({ source: 'firms', hazardType: 'wildfire', severity: 'severe', point: { lon: -118.5432, lat: 34.1234 } });
    expect(e!.startsAt).toBe('2026-11-10T09:15:00.000Z');
    expect(e!.key).toBe('VIIRS_NOAA20_NRT:2026-11-10:0915:34.1234:-118.5432');
    expect(parseFirmsCsv('Invalid MAP_KEY.', 'x')).toEqual([]);
  });

  it('river gauges: only gauges at action stage or flooding, as episodic events', () => {
    const events = parseRiverGauges([
      { geometry: null, properties: { gaugelid: 'AMRL1', status: 'moderate', waterbody: 'Atchafalaya River', location: 'Amerada Pass', state: 'LA', latitude: 29.45, longitude: -91.34, observed: '5.2', units: 'ft', flood: '4', url: 'https://water.noaa.gov/gauges/amrl1' } },
      { geometry: null, properties: { gaugelid: 'AACS2', status: 'no_flooding', latitude: 43.3, longitude: -103.5 } },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: 'AMRL1', episodic: true, severity: 'severe', hazardType: 'flood', eventName: 'River gauge: moderate flooding' });
  });

  it('FEMA: one event per declaration covering its counties as zone codes', () => {
    const row = (county: string, area: string): FemaRow => ({
      femaDeclarationString: 'DR-4955-FL', disasterNumber: 4955, state: 'FL', declarationType: 'DR', declarationDate: '2026-10-27T00:00:00.000Z',
      incidentType: 'Hurricane', declarationTitle: 'HURRICANE ISAIAS', fipsCountyCode: county, designatedArea: area,
    });
    const events = parseFemaDeclarations([row('005', 'Bay (County)'), row('033', 'Escambia (County)'), row('005', 'Bay (County)'), row('000', 'Statewide')]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: 'DR-4955-FL', severity: 'severe', hazardType: 'disaster_declaration', zoneCodes: ['FLC005', 'FLC033'] });
    expect(events[0]!.endsAt).toBe('2026-11-26T00:00:00.000Z');
  });
});

describe('text message', () => {
  it('states hazard, severity, properties, source, map link, disclaimer and opt-out', () => {
    const text = renderHazardSms({
      eventName: 'Tornado Warning',
      severity: 'extreme',
      sourceName: 'National Weather Service',
      isEscalation: false,
      properties: [1, 2, 3, 4].map((n) => ({ name: `Site ${n}`, address: null, clientName: 'Acme' })),
      mapUrl: 'https://app.example.test/?event=abc',
    });
    expect(text).toBe(
      'Tornado Warning (Extreme) affects 4 properties: Site 1, Site 2 +2 more. Source: National Weather Service. ' +
        'Map: https://app.example.test/?event=abc Supplements, does not replace, official warnings. Reply STOP to opt out.',
    );
  });
});

describe('phone numbers and inbound keywords', () => {
  it('normalizes US numbers to E.164 and rejects the rest', () => {
    expect(normalizeUsPhone('(555) 234-5678')).toBe('+15552345678');
    expect(normalizeUsPhone('1-555-234-5678')).toBe('+15552345678');
    expect(normalizeUsPhone('+1 555 234 5678')).toBe('+15552345678');
    expect(normalizeUsPhone('234-5678')).toBeNull();
    expect(normalizeUsPhone('155-234-5678')).toBeNull();
    expect(normalizeUsPhone('+44 20 7946 0958')).toBeNull();
  });

  it('recognizes opt-out and opt-in replies', () => {
    for (const word of ['STOP', ' stop ', 'Unsubscribe', 'CANCEL', 'end', 'QUIT', 'STOPALL', 'revoke', 'OPTOUT']) {
      expect(classifyInboundSms(word)).toBe('stop');
    }
    expect(classifyInboundSms('START')).toBe('start');
    expect(classifyInboundSms('unstop')).toBe('start');
    expect(classifyInboundSms('HELP')).toBe('help');
    expect(classifyInboundSms('please stop texting me')).toBe('other'); // only an exact keyword counts
    expect(classifyInboundSms('anything', 'STOP')).toBe('stop'); // Twilio's own classification wins
  });
});
