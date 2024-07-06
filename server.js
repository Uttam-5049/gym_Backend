const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const marked = require('marked');
const cors = require('cors');

const app = express();

// Middleware to parse JSON bodies and serve static files
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS configuration
const corsOptions = {
  origin: "*", // Replace with your frontend URL
  methods: ["GET", "POST"],
  optionsSuccessStatus: 200 // For legacy browser support
};

app.use(cors(corsOptions)); // Use CORS with the specified options

// Create an HTTP server
const server = http.createServer(app);

// Create a Socket.io server with CORS settings
const io = new Server(server, {
  cors: corsOptions
});

// Object to store responses loaded from the JSON file
let responses = {};

// Function to calculate the probability of a user's message matching a set of recognized words
function messageProbability(userMessage, recognisedWords, singleResponse = false, requiredWords = []) {
  let messageCertainty = 0;
  let hasRequiredWords = true;

  userMessage.forEach(word => {
    if (recognisedWords.includes(word)) {
      messageCertainty += 1;
    }
  });

  const percentage = messageCertainty / recognisedWords.length;

  requiredWords.forEach(word => {
    if (!userMessage.includes(word)) {
      hasRequiredWords = false;
    }
  });

  if (hasRequiredWords || singleResponse) {
    return Math.floor(percentage * 100);
  } else {
    return 0;
  }
}

function makeKey(key) {
  return key.map(word => word.toUpperCase()).join('_');
}

function checkAllMessages(message, clientState) {
  if (clientState.initialConversation) {
    if (clientState.current_object["stored"]) {
      let storage_key = clientState.current_object["storage_key"];
      clientState.current_stored_data.push({ [storage_key]: message });
      console.log(clientState.current_stored_data);
    }

    if (clientState.current_object["next_response_id"] == "none") {
      if (clientState.current_object.options.hasOwnProperty(message.join(' '))) {
        clientState.current_object = responses[clientState.current_object.options[message.join(' ')]];
      } else {
        return "Sorry, I do not understand your input please try again";
      }
    } else if (clientState.current_object["further_instructions"].length != 0) {
      let instruction = clientState.current_object["further_instructions"];
      if (instruction[0] == '$') {
        clientState.current_object = responses[clientState.current_object["next_response_id"]];
      }
    } else {
      clientState.current_object = responses[clientState.current_object["next_response_id"]];
    }

    if (clientState.current_object["response"][0] == '$') {
      let prefix_key = clientState.current_object["response"].slice(2);
      console.log(prefix_key);
      let foundKey = false;
      for (let i = 0; i < clientState.current_stored_data.length; i++) {
        if (foundKey) break;
        Object.keys(clientState.current_stored_data[i]).forEach(key => {
          let temporary_key = prefix_key + makeKey(clientState.current_stored_data[i][key]);
          if (responses.hasOwnProperty(temporary_key)) {
            clientState.current_object = responses[temporary_key];
            foundKey = true;
          }
        });
      }
    }

    if (clientState.current_object["next_response_id"] == "end") {
      clientState.initialConversation = false;
    }

    return clientState.current_object["response"];
  }

  let highestProbList = {};

  function response(botResponse, listOfWords, singleResponse = false, requiredWords = []) {
    highestProbList[botResponse] = messageProbability(message, listOfWords, singleResponse, requiredWords);
  }

  try {
    let data = fs.readFileSync('responses.json', 'utf8');
    let json_data = JSON.parse(data);
    json_data.forEach(item => {
      response(item.response, item.listOfWords.split(' '), false, item.requiredWords.split(' '));
    });

    data = fs.readFileSync('single_responses.json', 'utf8');
    json_data = JSON.parse(data);
    json_data.forEach(item => {
      response(item.response, item.listOfWords.split(' '), true);
    });

    const bestMatch = Object.keys(highestProbList).reduce((a, b) => highestProbList[a] > highestProbList[b] ? a : b);

    if (highestProbList[bestMatch] < 1) {
      if (clientState.hardFallback != 3) {
        clientState.hardFallback += 1;
        console.log("this is a hardfallback");
      }
      clientState.hardFallback = 0;
      console.log("you should say hi now");
    }

    return bestMatch;
  } catch (error) {
    console.error('Error reading or parsing file:', error);
    throw new Error('Error reading or parsing file');
  }
}

function getResponse(userInput, clientState) {
  const splitMessage = userInput.toLowerCase().split(/\s+|[,;?!.-]\s*/);
  return checkAllMessages(splitMessage, clientState);
}

function loadResponsesSync() {
  try {
    const data = fs.readFileSync('conversation.json', 'utf8');
    const jsonArray = JSON.parse(data);

    jsonArray.forEach(item => {
      responses[item.id] = item;
    });

    console.log('Responses loaded successfully');
  } catch (err) {
    console.error('Error reading or parsing the file:', err);
  }
}

const clientStates = {};

io.on('connection', (socket) => {
  clientStates[socket.id] = {
    hardFallback: 0,
    current_object: {},
    current_stored_data: [],
    initialConversation: true
  };

  loadResponsesSync();

  clientStates[socket.id].current_object = responses["HELLO"];
  socket.emit('bot message', marked.parse(clientStates[socket.id].current_object["response"]));

  socket.on('user message', (message) => {
    const botResponse = getResponse(message, clientStates[socket.id]);
    socket.emit('bot message', marked.parse(botResponse));
  });

  socket.on('disconnect', () => {
    delete clientStates[socket.id];
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
