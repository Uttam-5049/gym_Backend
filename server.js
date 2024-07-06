const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const marked = require("marked"); // Import the marked library for Markdown parsing
const cors = require("cors"); // Import the CORS package

const app = express();

// CORS configuration
const corsOptions = {
  origin: "http://localhost:3000", // replace with your frontend URL
  optionsSuccessStatus: 200, // some legacy browsers choke on 204
};

app.use(cors(corsOptions)); // Use CORS with the specified options

// Middleware to parse JSON bodies and serve static files
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Create an HTTP server
const server = http.createServer(app);

// Create a Socket.io server with CORS settings
const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000", // Allow requests from this origin (React app)
    methods: ["GET", "POST"],
  },
});

// Object to store responses loaded from the JSON file
let responses = {};

// Function to calculate the probability of a user's message matching a set of recognized words
function messageProbability(
  userMessage,
  recognisedWords,
  singleResponse = false,
  requiredWords = []
) {
  let messageCertainty = 0;
  let hasRequiredWords = true;

  // Calculate how many recognized words are in the user's message
  userMessage.forEach((word) => {
    if (recognisedWords.includes(word)) {
      messageCertainty += 1;
    }
  });

  const percentage = messageCertainty / recognisedWords.length;

  // Check if all required words are present
  requiredWords.forEach((word) => {
    if (!userMessage.includes(word)) {
      hasRequiredWords = false;
    }
  });

  // If required words are present or if it's a single response, return the calculated probability
  if (hasRequiredWords || singleResponse) {
    return Math.floor(percentage * 100);
  } else {
    return 0;
  }
}

// Function to format a key from an array of words
function makeKey(key) {
  let formattedKey = key.map((word) => word.toUpperCase()).join("_");
  return formattedKey;
}

/*The functions checkAllMessages and getResponse have been modified to take a clientState parameter,
which allows them to operate on the individual client's state.
*/
// Function to check all messages and determine the best response
function checkAllMessages(message, clientState) {
  // Handle the initial conversation
  if (clientState.initialConversation) {
    // If the current object requires storage, store the message
    if (clientState.current_object["stored"]) {
      let storage_key = clientState.current_object["storage_key"];
      clientState.current_stored_data.push({ [storage_key]: message });
      console.log(clientState.current_stored_data);
    }

    // Determine the next response based on the current object's settings
    if (clientState.current_object["next_response_id"] == "none") {
      if (
        clientState.current_object.options.hasOwnProperty(message.join(" "))
      ) {
        clientState.current_object =
          responses[clientState.current_object.options[message.join(" ")]];
      } else {
        //If the input is not recognized (i.e., it does not exist in the options of the current object), the function returns "I do not understand your input".
        return "Sorry, I do not understand your input please try again"; // Handle unexpected input : This response is then sent back to the client, and the conversation continues from where it left off.
      }
    } else if (clientState.current_object["further_instructions"].length != 0) {
      let instruction = clientState.current_object["further_instructions"];
      if (instruction[0] == "$") {
        clientState.current_object =
          responses[clientState.current_object["next_response_id"]];
      }
    } else {
      clientState.current_object =
        responses[clientState.current_object["next_response_id"]];
    }

    // Handle special responses that refer to stored data
    if (clientState.current_object["response"][0] == "$") {
      let prefix_key = clientState.current_object["response"].slice(2);
      console.log(prefix_key);
      let foundKey = false;
      for (let i = 0; i < clientState.current_stored_data.length; i++) {
        if (foundKey) {
          break;
        }
        Object.keys(clientState.current_stored_data[i]).forEach((key) => {
          let temporary_key =
            prefix_key + makeKey(clientState.current_stored_data[i][key]);
          if (responses.hasOwnProperty(temporary_key)) {
            clientState.current_object = responses[temporary_key];
            foundKey = true;
          }
        });
      }
    }

    // End initial conversation if specified
    if (clientState.current_object["next_response_id"] == "end") {
      clientState.initialConversation = false;
    }

    return clientState.current_object["response"];
  }

  // Default response handling for non-initial conversation
  let highestProbList = {};

  // Helper function to record the probability of each possible response
  function response(
    botResponse,
    listOfWords,
    singleResponse = false,
    requiredWords = []
  ) {
    highestProbList[botResponse] = messageProbability(
      message,
      listOfWords,
      singleResponse,
      requiredWords
    );
  }

  try {
    // Read and parse the responses from JSON files
    let data = fs.readFileSync("responses.json", "utf8");
    let json_data = JSON.parse(data);
    json_data.forEach((item) => {
      response(
        item.response,
        item.listOfWords.split(" "),
        false,
        item.requiredWords.split(" ")
      );
    });

    data = fs.readFileSync("single_responses.json", "utf8");
    json_data = JSON.parse(data);
    json_data.forEach((item) => {
      response(item.response, item.listOfWords.split(" "), true);
    });

    // Determine the best response based on the highest probability
    const bestMatch = Object.keys(highestProbList).reduce((a, b) =>
      highestProbList[a] > highestProbList[b] ? a : b
    );

    // Handle fallback logic if no good match is found
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
    console.error("Error reading or parsing file:", error);
    throw new Error("Error reading or parsing file");
  }
}

// Function to get a response based on user input
function getResponse(userInput, clientState) {
  const splitMessage = userInput.toLowerCase().split(/\s+|[,;?!.-]\s*/);
  return checkAllMessages(splitMessage, clientState);
}

// Function to load responses from a JSON file
function loadResponsesSync() {
  try {
    // Read the JSON file synchronously
    const data = fs.readFileSync("conversation.json", "utf8");

    // Parse JSON string into a JavaScript array
    const jsonArray = JSON.parse(data);

    // Loop through the array and add each item to the responses object
    jsonArray.forEach((item) => {
      responses[item.id] = item;
    });

    console.log("Responses loaded successfully");
  } catch (err) {
    console.error("Error reading or parsing the file:", err);
  }
}

// Each client's state is stored in the clientStates object using the client's socket.id as the key.
// Store each client's state
const clientStates = {};

// Handle socket connections
io.on("connection", (socket) => {
  // Initialize state for the new client
  clientStates[socket.id] = {
    hardFallback: 0,
    current_object: {},
    current_stored_data: [],
    initialConversation: true,
  };

  // Load responses from JSON file
  loadResponsesSync();

  // Set the initial response object for the client
  clientStates[socket.id].current_object = responses["HELLO"];

  // Send a greeting message when a client connects
  socket.emit(
    "bot message",
    marked.parse(clientStates[socket.id].current_object["response"])
  );

  // Handle incoming messages from the client
  socket.on("user message", (message) => {
    // Get the bot's response based on the client's message and state
    const botResponse = getResponse(message, clientStates[socket.id]);
    // Send the bot's response back to the client
    socket.emit("bot message", marked.parse(botResponse));
  });

  // Handle client disconnection
  socket.on("disconnect", () => {
    // Clean up the client's state when they disconnect
    delete clientStates[socket.id];
  });
});

// Start the server on the specified port
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
