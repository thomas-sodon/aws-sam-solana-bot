FROM public.ecr.aws/lambda/nodejs:20 AS builder
WORKDIR /usr/app
RUN npm install -g yarn@1.22.22
COPY package.json yarn.lock tsconfig.json ./
RUN yarn install --frozen-lockfile --non-interactive
COPY ./src/ ./src/
RUN yarn bundle

FROM public.ecr.aws/lambda/nodejs:20
WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=builder /usr/app/dist ./
COPY ./config/ ./config/
CMD ["app.lambdaHandler"]
