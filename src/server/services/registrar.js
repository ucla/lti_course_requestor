const axios = require('axios');
const https = require('https');
const fs = require('fs');
const registrarDebug = require('debug')('registrar:api');
require('dotenv').config();

let registrar = {};

/**
 * Retrieves token from web service.
 *
 * @returns {string}
 */
async function getToken() {
  registrarDebug('getToken called');
  const data = 'grant_type=client_credentials';
  const certFile = process.env.REG_WS_CERT_NAME;
  const keyFile = process.env.REG_WS_PRIVATE_KEY;

  const httpsAgent = new https.Agent({
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
  });

  const tokenConfig = {
    method: 'post',
    url: `${process.env.REG_WS_API_URL}:4443/oauth2/token`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    auth: {
      username: process.env.REG_WS_CLIENT_ID,
      password: process.env.REG_WS_SECRET,
    },
    data,
    httpsAgent,
  };

  try {
    const response = await axios(tokenConfig, httpsAgent);
    const { access_token: token } = response.data;
    registrarDebug(`getToken returning ${token}`);
    return token;
  } catch (error) {
    console.log(error);
  }
}

/**
 * Stores token in environment variable.
 *
 * @param {string} token Token to cache.
 */
async function cacheToken(token) {
  registrarDebug('cacheToken called');
  try {
    process.env.reg_token = token;
  } catch (error) {
    console.log(error);
  }
}

/**
 * Called when token is invalid. Gets new token and stores it.
 *
 * @returns {string}    Returns cached token.
 */
async function refreshToken() {
  registrarDebug('refreshToken called');
  try {
    const token = await registrar.getToken();
    await registrar.cacheToken(token);
    return token;
  } catch (error) {
    console.log(error);
  }
}

/**
 * Makes call to Registrar web service endpoint.
 *
 * @param {object} params   Should have relative path url set. Passed to axios.
 * @returns {?string}       JSON with data from web service.
 * @throws Exception if server returns 400 or 500 error.
 */
async function call(params) {
  registrarDebug(`call called with ${JSON.stringify(params)}`);
  try {
    const token =
      process.env.reg_token === undefined
        ? await registrar.refreshToken()
        : process.env.reg_token;

    if (params.headers === undefined) {
      params.headers = { esmAuthnClientToken: token };
    } else {
      params.headers.esmAuthnClientToken = token;
    }

    params.baseURL = process.env.REG_WS_API_URL;
    console.log('registrar called with token ------------!');
    console.log(token);

    const response = await axios(params);
    registrarDebug(`call returning with ${response.data}`);
    return response.data;
  } catch (error) {
    if (error.response.status === 401 || error.response.status === 403) {
      // Token may have expired
      registrarDebug('call: Token may have expired, retrying');
      params.headers.esmAuthnClientToken = await registrar.refreshToken();
      const retryResponse = await axios(params);
      if (retryResponse.status === 200) {
        registrarDebug(`call returning with ${retryResponse.data}`);
        return retryResponse.data;
      }
    } else if (error.response.status === 404) {
      registrarDebug('call returning null (404 response)');
      return null;
    }
    registrarDebug(`call throwing error ${error}`);
    const errorObject = new Error(error.message);
    errorObject.code = error.response.status;
    throw errorObject;
  }
}

/**
 * Converts a given offeredTermCode and classSectionID to the following
 * shortname format:
 *
 *  Strip spaces/ampersands from subject areas.
 *      <3 char term>-<subject area><display course number>-<display section number>
 *
 * @param {string} offeredTermCode  Term.
 * @param {string} classSectionID   ClassID aka SRS.
 * @returns {?string}   Returns shortname if CourseClassIdentifiers were found.
 */
async function getShortname(offeredTermCode, classSectionID) {
  registrarDebug(
    `getShortname: called with ${offeredTermCode}|${classSectionID}`
  );
  let term = offeredTermCode;
  try {
    let response = await registrar.call({
      url: `/sis/api/v1/Dictionary/${offeredTermCode}/${classSectionID}/CourseClassIdentifiers`,
    });
    if (response === null) {
      registrarDebug('getShortname: CourseClassIdentifiers is null');
      return null;
    }
    const {
      courseClassIdentifiers: [
        {
          courseClassIdentifierCollection: [
            {
              subjectAreaCode: subArea,
              courseCatalogNumber: catNum,
              classSectionNumber: secNum,
            },
          ],
        },
      ],
    } = response;

    // Check if course is summer sessions.
    if (offeredTermCode.slice(-1) === '1') {
      registrarDebug('getShortname: Handling Summer session');
      // Get session group.
      response = await registrar.call({
        url: `/sis/api/v1/Classes/${offeredTermCode}`,
        params: {
          subjectAreaCode: subArea,
          courseCatalogNumber: catNum,
          classNumber: secNum,
        },
      });

      if (response === null) {
        registrarDebug('getShortname: Classes is null');
        return null;
      }

      // Find the session that matches the class number.
      let sessionGroup = '';
      response.classes[0].termSessionGroupCollection.forEach(groupItem => {
        groupItem.classCollection.forEach(classItem => {
          if (classItem.classNumber === secNum) {
            sessionGroup = groupItem.termsessionGroupCode;
          }
        });
      });

      registrarDebug(`getShortname: using sessionGroup ${sessionGroup}`);
      term += sessionGroup;
    }

    // Format catNum from 0000SSPP to PP . int(0000) . SS.
    // SS are section letters. PP is C(oncurrent) and/or M(ultilisted).
    const formattedCatNum =
      catNum.substr(6, 2).trim() +
      parseInt(catNum.substr(0, 4)) +
      catNum.substr(4, 2).trim();

    // Remove spaces and ampersands.
    const shortname = `${term}-${subArea.replace(
      /\s|&/g,
      ''
    )}${formattedCatNum}-${secNum.replace(/^0+/g, '')}`;

    registrarDebug(`getShortname: returning ${shortname}`);
    return shortname;
  } catch (error) {
    console.log(error);
    return null;
  }
}

registrar = {
  getShortname,
  call,
  getToken,
  cacheToken,
  refreshToken,
};

module.exports = registrar;
