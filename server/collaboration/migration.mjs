import {optionalSchemaMigration} from './migration-support.mjs';
const migration=optionalSchemaMigration({file:new URL('./schema.sql',import.meta.url),key:'_club_collaboration_migration',version:'collaboration-v1'});
export const initializeCollaborationDatabase=migration.initialize;
export const collaborationMigrationTables=migration.verify;
