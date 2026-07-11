FROM node:20-alpine

WORKDIR /app

# Copy prisma first (needed for postinstall prisma generate)
COPY prisma/ ./prisma/

# Copy package files and install (postinstall runs prisma generate)
COPY package*.json ./
RUN npm install --omit=dev

# Generate Prisma client explicitly
RUN npx prisma generate

# Copy source
COPY sources/ ./sources/
COPY tsconfig.json ./

# Start command: baseline + migrate deploy + server
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma generate && npx tsx ./sources/main.ts"]
