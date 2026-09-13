/*
  Warnings:

  - You are about to drop the column `discordId` on the `Member` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "responseState" TEXT NOT NULL,
    CONSTRAINT "Member_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Member" ("id", "name", "optedOut", "phone", "responseState", "tripId") SELECT "id", "name", "optedOut", "phone", "responseState", "tripId" FROM "Member";
DROP TABLE "Member";
ALTER TABLE "new_Member" RENAME TO "Member";
CREATE UNIQUE INDEX "Member_tripId_phone_key" ON "Member"("tripId", "phone");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
