const appUser = process.env.MONGO_APP_USERNAME;
const appPassword = process.env.MONGO_APP_PASSWORD;
const appDatabase = process.env.MONGO_APP_DATABASE || 'support';

if (!appUser || !appPassword) {
  throw new Error('MONGO_APP_USERNAME and MONGO_APP_PASSWORD are required');
}

const appDb = db.getSiblingDB(appDatabase);
if (!appDb.getUser(appUser)) {
  appDb.createUser({
    user: appUser,
    pwd: appPassword,
    roles: [{ role: 'readWrite', db: appDatabase }],
  });
}
