// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 146,
    description: 'rename the shared-expenses receipt folder to the canonical module name',
    up(db) {
      // EIN MODUL, EIN NAME - nachgezogen fuer den Ordner, in dem die Belege
      // liegen. Das Modul heisst `splitExpenses.title` ("Gemeinsame Ausgaben"),
      // der Zielordner hiess `documents.splitExpensesFolder` und war in elf von
      // vierundzwanzig Sprachen ein anderes Wort. Der Locale-Wert ist mit
      // diesem Release auf den Modulnamen gezogen - ohne diese Migration
      // entstuende bei jedem Bestandshaushalt beim naechsten Beleg ein ZWEITER
      // Ordner, weil `ensureFolder` (server/routes/documents.js) den Ordner
      // ueber seinen NAMEN sucht und sonst anlegt. Die alten Belege blieben im
      // alten.
      //
      // Die Paare stehen hier ausgeschrieben und werden NICHT aus den
      // Locale-Dateien gelesen: eine Migration ist ein historischer Fakt und
      // muss in fuenf Jahren dasselbe tun wie heute. Ein Blick in die dann
      // aktuellen Uebersetzungen wuerde in einem spaeteren Rename still etwas
      // anderes umbenennen als hier gemeint war.
      const RENAMES = [
        ['النفقات المشتركة', 'المصاريف المشتركة'],   // ar
        ['Sdílené výdaje', 'Společné výdaje'],       // cs
        ['Geteilte Ausgaben', 'Gemeinsame Ausgaben'], // de
        ['Κοινές δαπάνες', 'Κοινά έξοδα'],           // el
        ['Közös kiadások', 'Megosztott költségek'],  // hu
        ['Pengeluaran bersama', 'Pengeluaran Bersama'], // id
        ['共同の支出', '共有費用'],                    // ja
        ['Despesas partilhadas', 'Despesas compartilhadas'], // pt
        ['Paylaşılan harcamalar', 'Paylaşılan giderler'],    // tr
        ['Chi tiêu chung', 'Chi phí chung'],         // vi
        ['共同支出', '共享支出'],                      // zh
      ];

      // Der Ordner traegt die Sprache, in der er entstanden ist, und ein
      // Haushalt kann die Sprache gewechselt haben - deshalb wird jede der elf
      // Zeilen geprueft statt nur die des aktuellen Locales. Getroffen wird
      // hoechstens eine.
      // Der Quellordner wird EXAKT gesucht, der Konflikt dagegen mit
      // `COLLATE NOCASE` - und dort mit `id <> ?`, statt einen beliebigen
      // Treffer hinterher gegen die eigene id zu halten.
      //
      // Der Unterschied ist der Startabbruch: `name` traegt ein `UNIQUE`
      // (Migration 60). Bei `id` unterscheiden sich alt und neu NUR in der
      // Grossschreibung, ein Haushalt kann also beide Ordner besitzen -
      // "Pengeluaran bersama" und "Pengeluaran Bersama" nebeneinander, vom
      // case-sensitiven UNIQUE ausdruecklich erlaubt. Ein NOCASE-Blick auf
      // den Zielnamen liefert dann dieselbe erste Zeile wie der Blick auf den
      // Quellnamen, ein Vergleich `clash.id !== source.id` haelte das faelsch-
      // licherweise fuer konfliktfrei, und das folgende UPDATE liefe in die
      // UNIQUE-Verletzung. Migration v146 braeche ab, und mit ihr der Start.
      const findExact = db.prepare('SELECT id FROM family_document_folders WHERE name = ?');
      const findClash = db.prepare('SELECT id FROM family_document_folders WHERE name = ? COLLATE NOCASE AND id <> ?');
      const rename = db.prepare('UPDATE family_document_folders SET name = ? WHERE id = ?');

      for (const [from, to] of RENAMES) {
        const source = findExact.get(from);
        if (!source) continue;

        // Zielname schon vergeben? Dann NICHT umbenennen. Zwei Ordner mit
        // demselben Namen waeren schlimmer als ein Ordner mit dem alten:
        // `ensureFolder` nimmt den ersten Treffer, und welcher das ist, haengt
        // an der Zeilenreihenfolge.
        if (findClash.get(to, source.id)) continue;

        rename.run(to, source.id);
      }
    },
  };
