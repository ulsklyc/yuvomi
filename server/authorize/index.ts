/**
 * Module: authorize (phase 2, section B)
 * Purpose: The interface of server/authorize/. Other modules import from this file
 *          only, never from the files behind it.
 */

export { actorForUser, actorFromRequest, householdAudience, resolveRequestModuleAccess } from './actor.ts';
