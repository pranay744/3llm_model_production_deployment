// Import the functions you need from the SDKs you need
import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBjsbWswPXcDTl1ekaM26g-Lg3fuiRionU",
  authDomain: "friendspro-1a50b.firebaseapp.com",
  projectId: "friendspro-1a50b",
  storageBucket: "friendspro-1a50b.appspot.com",
  messagingSenderId: "438646082167",
  appId: "1:438646082167:web:3de95ca28f4cd7ff841472",
  measurementId: "G-1RFELZTNY5"
};

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);

const db = getFirestore(app);

export { auth, db };
export default app;
