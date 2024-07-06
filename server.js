// Import required modules
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const marked = require('marked'); // Library to convert markdown to HTML
const cors = require('cors'); // Library to handle Cross-Origin Resource Sharing

// Initialize Express application
const app = express();

// Middleware to parse JSON and serve static files from the 'public' directory
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Define allowed origins for CORS
const allowedOrigins = ["http://localhost:3000", "http://another-frontend-url.com"]; // Update these URLs as needed

// Configure CORS middleware to allow requests from specific origins
app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST"]
}));

// Create an HTTP server using the Express app
const server = http.createServer(app);

// Object to store responses loaded from conversation.json
let responses = {};

// Initialize a Socket.io server with CORS configuration
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

// Function to calculate the probability of a user's message matching a set of recognized words
function messageProbability(userMessage, recognisedWords, singleResponse = false, requiredWords = []) {
  let messageCertainty = 0; // Initialize certainty score
  let hasRequiredWords = true; // Flag to check if all required words are present

  // Calculate the match score based on recognized words
  userMessage.forEach(word => {
    if (recognisedWords.includes(word)) {
      messageCertainty += 1;
    }
  });

  // Calculate percentage of recognized words in user message
  const percentage = messageCertainty / recognisedWords.length;

  // Check if all required words are present
  requiredWords.forEach(word => {
    if (!userMessage.includes(word)) {
      hasRequiredWords = false;
    }
  });

  // Return the final probability score
  if (hasRequiredWords || singleResponse) {
    return Math.floor(percentage * 100);
  } else {
    return 0;
  }
}

// Function to format keys for response objects
function makeKey(key) {
  return key.map(word => word.toUpperCase()).join('_');
}

/*The functions checkAllMessages and getResponse have been modified to take a clientState parameter,
which allows them to operate on the individual client's state.
*/
// Function to check all messages and determine the best response
function checkAllMessages(message, clientState) {
  let { current_object, current_stored_data, initialConversation } = clientState;

  // Handle the initial conversation flow
  if (initialConversation) {
    if (current_object["stored"]) {
      let storage_key = current_object["storage_key"];
      current_stored_data.push({ [storage_key]: message });
      console.log(current_stored_data);
    }

    let nextObjectKey;
    if (current_object["next_response_id"] === "none") {
      nextObjectKey = current_object.options[message.join(' ')];
    } else if (current_object["further_instructions"].length !== 0) {
      let instruction = current_object["further_instructions"];
      if (instruction[0] === '$') {
        nextObjectKey = current_object["next_response_id"];
      }
    } else {
      nextObjectKey = current_object["next_response_id"];
    }

    if (!nextObjectKey || !responses[nextObjectKey]) {
      console.error(`Next object key '${nextObjectKey}' not found in responses.`);
      return "I'm not sure how to respond to that.";
    }

    current_object = responses[nextObjectKey];

    if (current_object["response"][0] === '$') {
      let prefix_key = current_object["response"].slice(2);
      let foundKey = false;
      for (let i = 0; i < current_stored_data.length; i++) {
        if (foundKey) {
          break;
        }
        Object.keys(current_stored_data[i]).forEach(key => {
          let temporary_key = prefix_key + makeKey(current_stored_data[i][key]);
          if (responses.hasOwnProperty(temporary_key)) {
            current_object = responses[temporary_key];
            foundKey = true;
          }
        });
      }
      if (!foundKey) {
        console.error(`No matching key found for prefix '${prefix_key}' in stored data.`);
        return "I'm not sure how to respond to that.";
      }
    }

    if (current_object["next_response_id"] === "end") {
      initialConversation = false;
    }

    if (!current_object["response"]) {
      console.error(`Current object does not have a response: ${JSON.stringify(current_object)}`);
      return "I'm not sure how to respond to that.";
    }

    // Update client state
    clientState.current_object = current_object;
    clientState.initialConversation = initialConversation;
    clientState.current_stored_data = current_stored_data;

    return current_object["response"];
  }

  let highestProbList = {};

  // Define response function to populate highestProbList
  function response(botResponse, listOfWords, singleResponse = false, requiredWords = []) {
    highestProbList[botResponse] = messageProbability(message, listOfWords, singleResponse, requiredWords);
  }

  try {
    // Read and parse responses from files
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

    // Determine the best match from the highest probability list
    const bestMatch = Object.keys(highestProbList).reduce((a, b) => highestProbList[a] > highestProbList[b] ? a : b);

    if (highestProbList[bestMatch] < 1) {
      console.log("Fallback response triggered");
    }

    return bestMatch;

  } catch (error) {
    console.error('Error reading or parsing file:', error);
    throw new Error('Error reading or parsing file');
  }
}

// Function to get a response based on user input
function getResponse(userInput, clientState) {
  const splitMessage = userInput.toLowerCase().split(/\s+|[,;?!.-]\s*/);
  return checkAllMessages(splitMessage, clientState);
}

// Function to load responses synchronously from the conversation.json file
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

// Object to store the state of each connected client
const clientStates = {};

// Handle socket connections
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  loadResponsesSync();

  // Initialize state for the new client
  clientStates[socket.id] = {
    current_object: responses["HELLO"],
    current_stored_data: [],
    initialConversation: true
  };

  // Send initial response to the client
  socket.emit('bot message', marked.parse(clientStates[socket.id].current_object["response"]));

  // Handle incoming user messages
  socket.on('user message', (message) => {
    try {
      const botResponse = getResponse(message, clientStates[socket.id]);
      socket.emit('bot message', marked.parse(botResponse));
    } catch (err) {
      console.error('Error processing user message:', err);
      socket.emit('bot message', 'Sorry, there was an error processing your message.');
    }
  });

  // Handle client disconnection
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    delete clientStates[socket.id]; // Clean up client state
  });

  // Handle socket errors
  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });
});

// Handle uncaught exceptions globally
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Handle unhandled promise rejections globally
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
