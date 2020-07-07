"use strict";

const AWS = require("aws-sdk");
const xlsx = require("xlsx");
const axios = require("axios");
const request = require("request");
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const sharp = require('sharp');

const moment = require("moment-timezone");

const BUCKET_NAME = process.env.BUCKET_ASSETS;
const REGION = process.env.BUCKET_REGION;

const API_POSTS = "https://6jhb9dq2hj.execute-api.us-east-1.amazonaws.com/prod/posts";

const s3 = new AWS.S3();

module.exports.submit = (event, context, callback) => {
  /* Tes Deployment */
  const requestBody = JSON.parse(event.body);
  const {
    clientId,
    file,
    facebook,
    twitter,
    googleMyBusiness,
    timeZone,
    clients,
  } = requestBody;

  let setResult = [];

  if (
    typeof facebook !== "boolean" ||
    typeof twitter !== "boolean" ||
    typeof googleMyBusiness !== "boolean"
  ) {
    console.error("Validation Failed");
    errorValidation(callback, "Validation Failed");
  }
  let socialNetworks = {
    facebook: facebook,
    googleMyBusiness: googleMyBusiness,
    twitter: twitter,
  };

  if (typeof clientId !== "string" && typeof clients == "object") {
    console.log("Bulk Groups");

    clients.map((client) => {
      console.log("GET CLIENT with NAME", client);

      const params = {
        ExpressionAttributeValues: {
          ":assignedClient": client.value,
        },
        FilterExpression: "clientName = :assignedClient",
        ProjectionExpression: "id, clientName",
        TableName: process.env.CLIENTS_TABLE,
      };

      //const res = await dynamoDb.scan(params).promise();

      dynamoDb
        .scan(params)
        .promise()
        .then((result) => {
          console.log("Result client", result);
          let client = result.Items[0];
          bulkClient(client.id, socialNetworks, file, timeZone, (complete) => {
            if (complete) {
              console.log("Setter set result", complete);
              setResult.push(complete);
              console.log("@###", setResult.length == clients.map, setResult);
              console.log("BULK GROUP BEFORE UPLOAD SUCCESS", setResult);
              console.log(
                setResult.length == clients.length,
                setResult.length,
                clients.length
              );
              if (setResult.length == clients.length) {
                uploadSuccess(callback, setResult[0]);
              }
            }
          });
        })
        .catch((error) => {
          console.error(error);
          console.log("Couldn't fetch client.");
        });
    });

    /*
    const response = {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: JSON.stringify(result.Item),
    };
    callback(null, response);

    callback(null, {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: JSON.stringify({
        message: 'Couldn\'t fetch client.'
      })
    })
*/
  } else {
    console.log("Bulk client");

    bulkClient(clientId, socialNetworks, file, timeZone, (complete) => {
      if (complete) {
        console.log("Setter set result in Bulk Client", complete);

        setResult.push(complete);
        console.log("BULK CLIENT BEFORE UPLOAD SUCCESS", setResult);
        uploadSuccess(callback, setResult[0]);
      }
    });
  }
};

function bulkClient(clientId, sn, file, timeZone, complete) {
  const buf = Buffer.from(file, "base64");

  var wb = xlsx.read(buf, { type: "buffer" });
  var ws;
  var target_sheet = "Hoja 1";
  var target_sheet1 = "Sheet1";
  try {
    console.log("converting xlsx", wb.Sheets);
    ws = wb.Sheets[target_sheet] || wb.Sheets[target_sheet1];
    if (!ws) {
      errorValidation(callback, "The target not exists");
    }
  } catch (e) {
    errorValidation(callback, "Error converting file");
  }

  console.log("converting sheet to json");
  const posts = xlsx.utils.sheet_to_json(ws);

  var countSuccess = 0;
  var countPublished = 0;
  var countError = 0;
  let setError = [];
  var lengthPosts = posts.length;
  posts.map((post) => {
    let minutePost = post["minute"] || post["Minute"];

    minutePost = parseInt(minutePost) == 0 ? "1" : minutePost;
    console.log(post);
    let year = post["year"] || post["Year"];
    let month = post["month"] || post["Month"];
    let day = post["day"] || post["Day"];
    let hour = post["hour"] || post["Hour"];
    let minute = minutePost;
    let seconds = "00";
    let meridian = post["ampm"] || post["AmPm"];

    const dateTime =
      year +
      "-" +
      month +
      "-" +
      day +
      " " +
      hour +
      ":" +
      minute +
      ":" +
      seconds +
      " " +
      meridian;

    const formattedDateTime = moment(
      dateTime.toString(),
      "YYYY-MM-DD hh:mm:ss A"
    );

    const timeStamp = moment(formattedDateTime).valueOf();

    const offsetFromLocaltime = moment.tz.zone(timeZone).utcOffset(timeStamp);

    const fakeGMTDateTime = moment(timeStamp).add(
      offsetFromLocaltime,
      "minutes"
    );

    let clientLocalTime = moment.tz(fakeGMTDateTime, timeZone);

    const gmtDateTime = moment.tz(clientLocalTime, "GMT");

    const dateUnix = moment(gmtDateTime).valueOf();

    let message = post["all network message"] || post["all network Message"];

    let postImage = post["attached image"] || "";
    let ext = /([a-zA-Z0-9\s_\\.\-\(\):])+(.jpg|.jpeg|.png)/.exec(postImage);
    let namePostImage = `post${new Date().getTime()}.${ext}`;
    let urlImage = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${namePostImage}`;

    let postBody = {
      message: message,
      schedule: parseInt(dateUnix / 1000), //unix UTC
      createdAt: moment().unix(), //unix UTC
      socialNetworks: {
        facebook: sn.facebook || false,
        twitter: sn.twitter || false,
        googleMyBusiness: sn.googleMyBusiness || false,
      },
      isDraft: false,
      posted: false,
      recurrentDates: [],
      isScheduled: false,
    };
    postBody["clientId"] = clientId;

    console.log("postBody", postBody);
    request({
      url: postImage,
      encoding: null,
    }, function (err, res, body) {
        if (err) { console.error("Error Request image:", err); }

        sharp(body)
          .toFormat('jpeg')
          .jpeg({
            force: true,
          })
          .toBuffer()
          .then(data_img => {
            let buffer64 = "data:image/jpeg;base64," + data_img.toString('base64');
            let extn = /(jpg|jpeg|png|gif)/.exec(buffer64);
            if(extn == null) {
              console.log('File no Permitted');
              return false;
            }
            let nameFile = 'file' + new Date().getTime() +'.'+ extn[0];

            s3.putObject({
              Bucket: BUCKET_NAME,
              Key: nameFile,
              Body: data_img,
              ContentType: 'image/'+nameFile.split(".")[1]
            },function (err, data) {
              if (err) { console.log("error upload image", err); }
              else {
                postBody["images"] = [ {url: post["attached image"], text: nameFile} ];
                console.log("Upload POST", postBody);

                axios
                  .post(API_POSTS, JSON.stringify(postBody))
                  .then((response) => {
                    if (response) {
                      if (response.data.postData.schedule > moment().unix()) {
                        countSuccess = countSuccess + 1;
                      } else {
                        countPublished = countPublished + 1;
                      }
                      console.log("AADD SUCCESS response", response);
                      let resultS = {
                        "post-succeded": countSuccess,
                        "post-published": countPublished,
                        "post-error": countError,
                        setError: setError,
                      };
                      console.log( lengthPosts === countError + countSuccess, lengthPosts, countSuccess, countError, countError + countSuccess );
                      if ( lengthPosts === countError + countSuccess + countPublished ) {
                        if (complete) { complete(resultS); }
                      }
                    }
                  })
                  .catch((error) => {
                    if (error) {
                      console.log("ERROR IN ADD POST", error.response);
                      console.log(error.data);
                      countError = countError + 1;
                      setError.push({
                        post: postBody,
                        error: `${ error["response"] != undefined ? error["response"]["status"] : error } : ${ (error.response && error.response.data["message"]) || "" }`,
                      });
                      let result = {
                        "post-succeded": countSuccess,
                        "post-published": countPublished,
                        "post-error": countError,
                        setError: setError,
                      };
                      console.log( lengthPosts === countError + countSuccess, lengthPosts, countSuccess, countError, countError + countSuccess );
                      if ( lengthPosts === countError + countSuccess + countPublished ) {
                        const clientParams = {
                          TableName: process.env.CLIENTS_TABLE,
                          Key: { id: clientId },
                          UpdateExpression: "SET countPosts.error = countPosts.error + :inc",
                          ExpressionAttributeValues: { ":inc": countError },
                          ReturnValue: "UPDATED_NEW",
                        };
                        dynamoDb.update(clientParams, function (err, data) {
                          if (err) { console.error("Increment Counnter", err); }
                          if (data) { console.log("Increment Counnter", data); }
                        });
                        complete(result);
                      }
                    }
                  });
              }
            })
          })
          .catch(err => { console.error(err)});
    });
  });
}

function uploadSuccess(callback, setResult) {
  console.log("@# 17=>>>>>17 IN UPLOAD SUCCESS", setResult);

  callback(null, {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": true,
    },
    body: JSON.stringify(setResult),
  });
}

function errorValidation(callback, message) {
  callback(null, {
    statusCode: 500,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": true,
    },
    body: JSON.stringify({
      message:
        message || "Couldn't submit the bulk post because validation errors.",
    }),
  });
  return;
}
