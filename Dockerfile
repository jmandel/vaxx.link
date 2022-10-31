FROM node:lts-bullseye as build-deps

EXPOSE 3000

ENV DIRPATH /opt/app
WORKDIR ${DIRPATH}

COPY ui ${DIRPATH}/ui
COPY client ${DIRPATH}/client

WORKDIR ${DIRPATH}/ui

RUN npm ci
RUN REACT_APP_REAL_SERVER_BASE=${REACT_APP_REAL_SERVER_BASE} npm run build
RUN mv build ${DIRPATH}
RUN cp package.json ${DIRPATH}

WORKDIR ${DIRPATH}/client

RUN npm ci
RUN npm run build
RUN cp -r dist ${DIRPATH}/build/viewer

WORKDIR ${DIRPATH}

CMD ["npm", "start"]