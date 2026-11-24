export default {
    version: 185,
    description: 'Schedule: a personal weekly-hours target for the overtime flag',
    up: `
      -- NULL faellt auf den bisherigen festen Wert (40) zurueck - ein
      -- Bestandshaushalt sieht also keinen stillen Wechsel. Personenbezogen
      -- statt haushaltweit: ein Teilzeit- und ein Vollzeit-Mitglied im
      -- selben Haushalt haben unterschiedliche Sollstunden, und die
      -- Ueberstundenkarte in der Statistik rechnet je Person.
      ALTER TABLE users ADD COLUMN schedule_weekly_hours INTEGER;
    `,
  };
