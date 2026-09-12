import { corePaths } from './core.js';
import { authPaths } from './auth.js';
import { emailPaths } from './email.js';
import { familyPaths } from './family.js';
import { backupPaths } from './backup.js';
import { dashboardPaths } from './dashboard.js';
import { tasksPaths } from './tasks.js';
import { rewardsPaths } from './rewards.js';
import { shoppingPaths } from './shopping.js';
import { mealsPaths } from './meals.js';
import { recipesPaths } from './recipes.js';
import { pantryPaths } from './pantry.js';
import { inventoryPaths } from './inventory.js';
import { kitchenPaths } from './kitchen.js';
import { calendarPaths } from './calendar.js';
import { notesPaths } from './notes.js';
import { contactsPaths } from './contacts.js';
import { birthdaysPaths } from './birthdays.js';
import { budgetPaths } from './budget.js';
import { documentsPaths } from './documents.js';
import { weatherPaths } from './weather.js';
import { preferencesPaths } from './preferences.js';
import { remindersPaths } from './reminders.js';
import { searchPaths } from './search.js';
import { splitexpensesPaths } from './splitexpenses.js';
import { housekeepingPaths } from './housekeeping.js';
import { wastePaths } from './waste.js';
import { modulesPaths } from './modules.js';
import { pushPaths } from './push.js';
import { notificationsPaths } from './notifications.js';
import { healthPaths } from './health.js';
import { schedulePaths } from './schedule.js';
import { quickLinksPaths } from './quicklinks.js';
import { screensaverPaths } from './screensaver.js';
import { recipeProvidersPaths } from './recipeproviders.js';
import { permissionsPaths } from './permissions.js';

export function buildPaths() {
  return {
    ...corePaths(),
    ...authPaths(),
    ...emailPaths(),
    ...familyPaths(),
    ...backupPaths(),
    ...dashboardPaths(),
    ...tasksPaths(),
    ...rewardsPaths(),
    ...shoppingPaths(),
    ...mealsPaths(),
    ...recipesPaths(),
    ...pantryPaths(),
    ...inventoryPaths(),
    ...kitchenPaths(),
    ...calendarPaths(),
    ...notesPaths(),
    ...contactsPaths(),
    ...birthdaysPaths(),
    ...budgetPaths(),
    ...documentsPaths(),
    ...weatherPaths(),
    ...preferencesPaths(),
    ...remindersPaths(),
    ...searchPaths(),
    ...splitexpensesPaths(),
    ...housekeepingPaths(),
    ...wastePaths(),
    ...modulesPaths(),
    ...pushPaths(),
    ...notificationsPaths(),
    ...healthPaths(),
    ...schedulePaths(),
    ...quickLinksPaths(),
    ...screensaverPaths(),
    ...recipeProvidersPaths(),
    ...permissionsPaths(),
  };
}
