// @ts-nocheck - eingefrorene Migration (append-only): Typen nachziehen hiesse den Text aendern.

export default {
    version: 157,
    description: 'Document folders: a module folder is found by a stable key instead of its translated name',
    up(db) {
      // EIN SYSTEMORDNER, EINE ZEILE - unabhaengig von Sprache und Wortwahl.
      //
      // Sechs Module legen ihre Belege in einem eigenen Ordner ab: Budget,
      // Aufgaben, Gemeinsame Ausgaben, Inventar, Haushaltshilfe und die
      // Kalender-Anhaenge. Bisher war die IDENTITAET dieses Ordners sein
      // uebersetzter Anzeigename, und den schickte der Client mit. Daraus
      // folgten drei Fehler derselben Sorte:
      //
      //   1. Zwei Personen im selben Haushalt mit verschiedener Sprache legten
      //      ZWEI Ordner an - "Belege" und "Receipts" nebeneinander, jeder mit
      //      der Haelfte der Belege. Das war kein Randfall, sondern der
      //      Normalfall in einem mehrsprachigen Haushalt.
      //   2. Jede Korrektur an einer Uebersetzung spaltete den Ordner erneut.
      //      Migration v146 musste das einmal aufraeumen, und beim naechsten
      //      Sprachdurchgang stand dasselbe wieder an.
      //   3. Ein Tippfehler im Anzeigetext war ein DATEN-Fehler, nicht nur ein
      //      Schoenheitsfehler.
      //
      // `module_key` traegt die Identitaet ab jetzt. Der Name bleibt reine
      // Anzeige und darf sich frei aendern - eine Migration wie v146 wird
      // deshalb nie wieder noetig.
      db.exec('ALTER TABLE family_document_folders ADD COLUMN module_key TEXT');
      db.exec(`CREATE UNIQUE INDEX idx_family_document_folders_module_key
                 ON family_document_folders(module_key) WHERE module_key IS NOT NULL`);

      // Die Namen stehen hier AUSGESCHRIEBEN und werden nicht aus den
      // Locale-Dateien gelesen - dieselbe Ueberlegung wie in v146: eine
      // Migration ist ein historischer Fakt und muss in fuenf Jahren dasselbe
      // tun wie heute. Ein Blick in die dann aktuellen Uebersetzungen wuerde
      // still etwas anderes zuordnen als hier gemeint ist.
      const FOLDER_NAMES = [
        ['budget', [
          "الإيصالات", // ar
          "Doklady", // cs
          "Belege", // de
          "Αποδείξεις", // el
          "Receipts", // en
          "Comprobantes", // es
          "رسیدها", // fa
          "Mga Resibo", // fil
          "Justificatifs", // fr
          "रसीदें", // hi
          "Bizonylatok", // hu
          "Bukti", // id
          "Ricevute", // it
          "領収書", // ja
          "영수증", // ko
          "Bonnen", // nl
          "Dowody", // pl
          "Comprovativos", // pt
          "Чеки", // ru, uk
          "Kvitton", // sv
          "Fişler", // tr
          "Chứng từ", // vi
          "凭证", // zh
        ]],
        ['tasks', [
          "المهام", // ar
          "Úkoly", // cs
          "Aufgaben", // de
          "Εργασίες", // el
          "Tasks", // en
          "Tareas", // es
          "کارها", // fa
          "Mga gawain", // fil
          "Tâches", // fr
          "कार्य", // hi
          "Feladatok", // hu
          "Tugas", // id
          "Attività", // it
          "タスク", // ja
          "할 일", // ko
          "Taken", // nl
          "Zadania", // pl
          "Tarefas", // pt
          "Задачи", // ru
          "Uppgifter", // sv
          "Görevler", // tr
          "Завдання", // uk
          "Công việc", // vi
          "任务", // zh
        ]],
        ['splitExpenses', [
          "المصاريف المشتركة", // ar
          "Společné výdaje", // cs
          "Gemeinsame Ausgaben", // de
          "Κοινά έξοδα", // el
          "Shared expenses", // en
          "Gastos compartidos", // es
          "هزینه‌های مشترک", // fa
          "Mga hinating gastos", // fil
          "Dépenses partagées", // fr
          "साझा खर्च", // hi
          "Megosztott költségek", // hu
          "Pengeluaran Bersama", // id
          "Spese condivise", // it
          "共有費用", // ja
          "공동 지출", // ko
          "Gedeelde uitgaven", // nl
          "Wspólne wydatki", // pl
          "Despesas compartilhadas", // pt
          "Общие расходы", // ru
          "Delade utgifter", // sv
          "Paylaşılan giderler", // tr
          "Спільні витрати", // uk
          "Chi phí chung", // vi
          "共享支出", // zh
        ]],
        ['inventory', [
          // Bis 5bd02b26 hiess der Ordner in 21 Sprachen "Inventory", weil das
          // Modul mit englischen Texten ausgeliefert wurde. Seit der
          // Uebersetzung traegt er den Modulnamen der Sprache - beide
          // Schreibweisen stehen hier, nach derselben Regel wie bei der
          // Haushaltshilfe unten: die alte fuer Bestandsordner, die neue fuer
          // einen von Hand so benannten Ordner in einer nie migrierten Datenbank.
          "المقتنيات", // ar, seit der Uebersetzung des Moduls (5bd02b26)
          "Inventář", // cs, seit der Uebersetzung des Moduls (5bd02b26)
          "Απογραφή", // el, seit der Uebersetzung des Moduls (5bd02b26)
          "Inventario", // es, seit der Uebersetzung des Moduls (5bd02b26)
          "اموال", // fa, seit der Uebersetzung des Moduls (5bd02b26)
          "Inventaire", // fr, seit der Uebersetzung des Moduls (5bd02b26)
          "इन्वेंटरी", // hi, seit der Uebersetzung des Moduls (5bd02b26)
          "Leltár", // hu, seit der Uebersetzung des Moduls (5bd02b26)
          "Inventaris", // id, seit der Uebersetzung des Moduls (5bd02b26)
          "Inventario", // it, seit der Uebersetzung des Moduls (5bd02b26)
          "持ち物", // ja, seit der Uebersetzung des Moduls (5bd02b26)
          "소지품", // ko, seit der Uebersetzung des Moduls (5bd02b26)
          "Inventaris", // nl, seit der Uebersetzung des Moduls (5bd02b26)
          "Inwentarz", // pl, seit der Uebersetzung des Moduls (5bd02b26)
          "Inventário", // pt, seit der Uebersetzung des Moduls (5bd02b26)
          "Инвентарь", // ru, seit der Uebersetzung des Moduls (5bd02b26)
          "Inventarier", // sv, seit der Uebersetzung des Moduls (5bd02b26)
          "Envanter", // tr, seit der Uebersetzung des Moduls (5bd02b26)
          "Інвентар", // uk, seit der Uebersetzung des Moduls (5bd02b26)
          "Tài sản", // vi, seit der Uebersetzung des Moduls (5bd02b26)
          "物品", // zh, seit der Uebersetzung des Moduls (5bd02b26)
          "Inventory", // ar, cs, el, en, es, fa, fil, fr, hi, hu, id, it, ja, ko, nl, pl, pt, ru, sv, tr, uk, vi, zh
          "Imbentaryo", // fil
          "Inventar", // de
        ]],
        ['housekeeping', [
          // Der Ordner hiess in ZWOELF von vierundzwanzig Sprachen anders als
          // das Modul, dessen Belege er traegt. Seit diesem Release traegt er
          // ueberall den Modulnamen - beide Schreibweisen stehen deshalb hier,
          // die alte fuer Bestandsordner und die neue fuer den Fall, dass
          // jemand seinen Ordner schon von Hand so genannt hat.
          //
          // Eine Namensliste NACHTRAEGLICH zu ergaenzen ist erlaubt, obwohl
          // Migrationen sonst unantastbar sind: bei einer Bestandsinstallation
          // ist v157 laengst gelaufen und die Liste wirkungslos, bei einer
          // neuen ist die Tabelle leer. Was sich aendern darf, ist also nur,
          // wen eine noch nie migrierte Datenbank findet - und da hilft jeder
          // zusaetzliche Name.
          "التدبير المنزلي", // ar, seit dem Angleich an den Modulnamen
          "Domácí práce", // cs, seit dem Angleich an den Modulnamen
          "Haushaltshilfe", // de, seit dem Angleich an den Modulnamen
          "Νοικοκυριό", // el, seit dem Angleich an den Modulnamen
          "خدمتکار خانه", // fa, seit dem Angleich an den Modulnamen
          "गृहकार्य", // hi, seit dem Angleich an den Modulnamen
          "Asisten Rumah Tangga", // id, seit dem Angleich an den Modulnamen
          "家事", // ja, seit dem Angleich an den Modulnamen
          "가사 도우미", // ko, seit dem Angleich an den Modulnamen
          "Ev işleri", // tr, seit dem Angleich an den Modulnamen
          "家务", // zh, seit dem Angleich an den Modulnamen
          "التنظيف المنزلي", // ar
          "Úklid domácnosti", // cs
          "Hausreinigung", // de
          "Καθαριότητα", // el
          "HouseKeeping", // en
          "Limpieza", // es
          "نظافت خانه", // fa
          "Gawaing-bahay", // fil
          "Ménage", // fr
          "हाउसकीपिंग", // hi
          "HázTartás", // hu
          "Háztartás", // hu, nach der Tippfehler-Korrektur - SQLites COLLATE
                       // NOCASE gilt nur fuer ASCII und haelt die beiden
                       // Schreibweisen fuer zwei verschiedene Namen
          "Pembersihan rumah", // id
          "Pulizie", // it
          "ハウスキーピング", // ja
          "집 청소", // ko
          "Huishouden", // nl
          "Sprzątanie", // pl
          "Faxina", // pt
          "Уборка", // ru
          "Städning", // sv
          "Ev temizliği", // tr
          "Прибирання", // uk
          "Dọn dẹp", // vi
          "家政清洁", // zh
        ]],
        ['calendarItems', [
          "عناصر التقويم", // ar
          "Položky kalendáře", // cs
          "Kalendereinträge", // de
          "Στοιχεία ημερολογίου", // el
          "Calendar items", // en
          "Elementos del calendario", // es
          "مدخل‌های تقویم", // fa
          "Mga item sa kalendaryo", // fil
          "Éléments du calendrier", // fr
          "कैलेंडर आइटम", // hi
          "Naptár elemei", // hu
          "Entri kalender", // id
          "Elementi del calendario", // it
          "カレンダー項目", // ja
          "캘린더 항목", // ko
          "Kalenderitems", // nl
          "Wpisy kalendarza", // pl
          "Itens do calendário", // pt
          "Элементы календаря", // ru
          "Kalenderobjekt", // sv
          "Takvim öğeleri", // tr
          "Елементи календаря", // uk
          "Mục trên lịch", // vi
          "日历项目", // zh
        ]],
      ];

      const findAll = db.prepare(`SELECT id FROM family_document_folders
                                   WHERE name = ? COLLATE NOCASE ORDER BY id`);
      const claim = db.prepare('UPDATE family_document_folders SET module_key = ? WHERE id = ?');

      for (const [key, names] of FOLDER_NAMES) {
        // Der AELTESTE Ordner bekommt den Schluessel - ueber alle Sprachen
        // hinweg, nicht der erste Name, der zufaellig einen Treffer hat. Ein
        // Haushalt, der auf Englisch angefangen und spaeter auf Deutsch
        // umgestellt hat, besitzt "Receipts" UND "Belege"; der aeltere traegt
        // die Historie, und die Reihenfolge dieser Liste ist alphabetisch nach
        // Sprachkuerzel und damit ohne jede Bedeutung.
        //
        // Weitere Ordner desselben Zwecks bleiben bewusst stehen: sie
        // zusammenzulegen waere eine Entscheidung ueber fremde Dokumente, und
        // die trifft eine Migration nicht. Neue Belege landen ab jetzt alle im
        // aeltesten, der zweite bleibt als das liegen, was er ist.
        let oldest = null;
        for (const name of names) {
          for (const row of findAll.all(name)) {
            if (oldest === null || row.id < oldest) oldest = row.id;
            break;
          }
        }
        if (oldest !== null) claim.run(key, oldest);
      }
    },
  };
