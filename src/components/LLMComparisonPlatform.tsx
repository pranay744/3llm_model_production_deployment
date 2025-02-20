import type { JSX } from 'react';
import React, { useState, useRef, useEffect } from 'react';
import { Search, Upload, FileIcon, Share, Copy, Trash } from 'lucide-react';
import Image from 'next/image';
import { createWorker } from 'tesseract.js';
import * as PDFJS from 'pdfjs-dist';
import { TextItem } from 'pdfjs-dist/types/src/display/api';
import { Toaster, toast } from 'react-hot-toast';
import { auth, db } from '../firebase';
import { signOut, User } from 'firebase/auth';
import { collection, addDoc, query as firestoreQuery, where, getDocs, orderBy, limit } from 'firebase/firestore';
import Login from './Login';

// Update PDF.js worker configuration
PDFJS.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${PDFJS.version}/build/pdf.worker.min.js`;

// API Configuration
const API_CONFIG = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-2024-07-18',
    apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY
  },
  perplexity: {
    baseUrl: 'https://api.perplexity.ai',
    model: 'sonar',
    apiKey: process.env.NEXT_PUBLIC_PERPLEXITY_API_KEY
  }
};

interface Results {
  perplexity: string;
  chatgpt: string;
  gemini: string;
}

// Add type definitions
type SupportedFileTypes = {
  [key: string]: {
    extensions: string[];
    icon: JSX.Element;
    process: (file: File) => Promise<string>;
  };
};

// Add file processors
const fileProcessors = {
  text: async (file: File): Promise<string> => {
    return await file.text();
  },

  json: async (file: File): Promise<string> => {
    const text = await file.text();
    try {
      const jsonData = JSON.parse(text);
      return JSON.stringify(jsonData, null, 2);
    } catch {
      throw new Error('Invalid JSON file');
    }
  },

  csv: async (file: File): Promise<string> => {
    const text = await file.text();
    return text.split('\n')
      .map(line => line.split(',').map(cell => cell.trim()).join(' '))
      .join('\n');
  },

  html: async (file: File): Promise<string> => {
    const text = await file.text();
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;
    return tempDiv.textContent || tempDiv.innerText || '';
  },

  xml: async (file: File): Promise<string> => {
    const text = await file.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(text, 'text/xml');
    return xmlDoc.documentElement.textContent || '';
  },

  image: async (file: File): Promise<string> => {
    const worker = await createWorker('eng');
    const imageUrl = URL.createObjectURL(file);
    const { data: { text } } = await worker.recognize(imageUrl);
    await worker.terminate();
    URL.revokeObjectURL(imageUrl);
    return text;
  }
};

// Define supported file types
const SUPPORTED_FILE_TYPES: SupportedFileTypes = {
  'text/plain': {
    extensions: ['.txt'],
    icon: <FileIcon className="w-4 h-4" />,
    process: fileProcessors.text
  },
  'text/markdown': {
    extensions: ['.md', '.markdown'],
    icon: <FileIcon className="w-4 h-4" />,
    process: fileProcessors.text
  },
  'application/json': {
    extensions: ['.json'],
    icon: <FileIcon className="w-4 h-4" />,
    process: fileProcessors.json
  },
  'text/csv': {
    extensions: ['.csv'],
    icon: <FileIcon className="w-4 h-4" />,
    process: fileProcessors.csv
  },
  'text/html': {
    extensions: ['.html', '.htm'],
    icon: <FileIcon className="w-4 h-4" />,
    process: fileProcessors.html
  },
  'application/xml': {
    extensions: ['.xml'],
    icon: <FileIcon className="w-4 h-4" />,
    process: fileProcessors.xml
  },
  'image/png': {
    extensions: ['.png'],
    icon: <FileIcon className="w-4 h-4" />,
    process: fileProcessors.image
  },
  'image/jpeg': {
    extensions: ['.jpg', '.jpeg'],
    icon: <FileIcon className="w-4 h-4" />,
    process: fileProcessors.image
  },
  'application/pdf': {
    extensions: ['.pdf'],
    icon: <FileIcon className="w-4 h-4" />,
    process: async (file: File) => {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await PDFJS.getDocument({ data: arrayBuffer }).promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items
          .filter((item): item is TextItem => 'str' in item)
          .map(item => item.str)
          .join(' ') + '\n';
      }
      return text;
    }
  },
};

// Add a timeout utility
function timeoutPromise<T>(promise: Promise<T>, timeout: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error('Request timed out')), timeout)
    )
  ]);
}

// Add new interfaces for query history
interface QueryResponse {
  query: string;
  timestamp: number;
  parentId?: number;  // Reference to parent query
  responses: {
    perplexity: string;
    chatgpt: string;
    gemini: string;
  };
}

// Add LLM configuration
const LLM_CONFIG = [
  { id: 'chatgpt', name: 'ChatGPT', color: 'blue' },
  { id: 'gemini', name: 'Gemini', color: 'purple' },
  { id: 'perplexity', name: 'Perplexity', color: 'green' }
];

// Add helper functions
const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard!');
  } catch (err) {
    console.error('Failed to copy:', err);
    toast.error('Failed to copy to clipboard');
  }
};

const handleShare = async (llmName: string, text: string) => {
  try {
    if (navigator.share) {
      await navigator.share({
        title: `${llmName} Response`,
        text: text
      });
      toast.success('Shared successfully!');
    } else {
      await copyToClipboard(text);
      toast.success('Link copied to clipboard - you can now share it!');
    }
  } catch (err) {
    console.error('Failed to share:', err);
    toast.error('Failed to share content');
  }
};

// Add response formatter

// Update the theme colors and styling
const ThemeToggle = ({ isDarkMode, setIsDarkMode }: {
  isDarkMode: boolean;
  setIsDarkMode: (value: boolean) => void;
}) => (
  <button
    onClick={() => setIsDarkMode(!isDarkMode)}
    className={`p-2 rounded-lg ${
      isDarkMode 
        ? 'bg-gray-700 text-gray-200' 
        : 'bg-white text-gray-700 shadow-sm border border-gray-200'
    } hover:opacity-80 transition-colors ml-2`}
    title={`Switch to ${isDarkMode ? 'light' : 'dark'} mode`}
  >
    {isDarkMode ? '🌙' : '☀️'}
  </button>
);

// Add a unified response actions component
const ResponseActions = ({
  response,
  llmName,
  isDarkMode
}: {
  response: string;
  llmName: string;
  isDarkMode: boolean;
}) => (
  <div className="flex gap-2">
    <button
      onClick={() => copyToClipboard(response)}
      className={`p-2 rounded hover:opacity-80 transition-colors ${
        isDarkMode ? 'text-gray-300 hover:text-white' : 'text-gray-600 hover:text-gray-800'
      }`}
      title="Copy to clipboard"
    >
      <Copy size={16} />
    </button>
    <button
      onClick={() => handleShare(llmName, response)}
      className={`p-2 rounded hover:opacity-80 transition-colors ${
        isDarkMode ? 'text-gray-300 hover:text-white' : 'text-gray-600 hover:text-gray-800'
      }`}
      title="Share response"
    >
      <Share size={16} />
    </button>
  </div>
);

// Update ResultTile component styling
const ResultTile = ({ 
  llm,
  response,
  isLoading,
  onFollowUp: _onFollowUp,
  isDarkMode,
  textSize,  // Add this prop
}: {
  llm: typeof LLM_CONFIG[0],
  response?: string,
  isLoading?: boolean,
  onFollowUp?: (text: string) => void,
  isDarkMode: boolean,
  textSize: number,  // Add this type
}) => (
  <div className={`flex-1 p-4 rounded-lg min-h-[200px] border ${
    isDarkMode 
      ? 'bg-gray-800 border-gray-700 text-white' 
      : 'bg-white border-gray-200 text-gray-800 shadow-md hover:shadow-lg transition-shadow'
  }`}>
    <div className="flex justify-between items-center mb-5">
      <h3 className={`text-xl font-bold ${
        isDarkMode 
          ? 'text-blue-400' 
          : `text-${llm.color}-700`
      }`}>
        {llm.name}
      </h3>
      {response && !isLoading && (
        <ResponseActions
          response={response}
          llmName={llm.name}
          isDarkMode={isDarkMode}
        />
      )}
    </div>
    <div className={`whitespace-pre-wrap font-normal leading-relaxed ${
      isDarkMode ? 'text-gray-200' : 'text-gray-700'
    }`} style={{ fontSize: `${textSize - 2}px` }}>
      {isLoading ? (
        <div className="animate-pulse">Loading...</div>
      ) : response ? (
        <div className="space-y-2">
          {response.split('\n\n').map((paragraph, index) => {
            if (paragraph.startsWith('💠')) { // Main heading
              return (
                <h1 key={index} className={`font-bold mb-4 ${
                  isDarkMode ? 'text-blue-400' : 'text-blue-700'
                }`} style={{ fontSize: `${(textSize - 2) * 1.25}px` }}>
                  {paragraph}
                </h1>
              );
            } else if (paragraph.startsWith('🔷')) { // Subheading
              return (
                <h2 key={index} className={`font-semibold mb-3 ${
                  isDarkMode ? 'text-blue-300' : 'text-blue-600'
                }`} style={{ fontSize: `${(textSize - 2) * 1.15}px` }}>
                  {paragraph}
                </h2>
              );
            } else if (paragraph.startsWith('🔹')) { // Small heading
              return (
                <h3 key={index} className={`font-medium mb-2 ${
                  isDarkMode ? 'text-blue-200' : 'text-blue-500'
                }`} style={{ fontSize: `${(textSize - 2) * 1.1}px` }}>
                  {paragraph}
                </h3>
              );
            } else if (paragraph.startsWith('•') || paragraph.startsWith('📍')) { // Lists
              return (
                <div key={index} className={`pl-4 mb-2 ${
                  isDarkMode ? 'text-gray-300' : 'text-gray-600'
                }`}>
                  {paragraph}
                </div>
              );
            } else if (paragraph.startsWith('📝')) { // Notes
              return (
                <div key={index} className={`p-2 rounded-md mb-2 ${
                  isDarkMode ? 'bg-gray-700' : 'bg-gray-50 border border-gray-200'
                }`}>
                  {paragraph}
                </div>
              );
            }
            return <p key={index} className="mb-2">{paragraph}</p>;
          })}
        </div>
      ) : (
        <div className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>
          Waiting for search query...
        </div>
      )}
    </div>
  </div>
);

// Update ChatHistoryItem component styling
const ChatHistoryItem = ({
  item,
  isDarkMode,
  onFollowUp: _onFollowUp,
  onDelete: _onDelete,
  textSize,  // Add this prop
}: {
  item: QueryResponse;
  isDarkMode: boolean;
  onFollowUp: (query: string, timestamp: number) => void;
  onDelete: (timestamp: number) => void;
  textSize: number;  // Add this type
}) => (
  <div className={`${
    isDarkMode 
      ? 'bg-gray-800 border-gray-700' 
      : 'bg-white border-gray-200 shadow-sm hover:shadow transition-shadow'
  } rounded-lg p-4 mb-4 border`}>
    <div className="flex justify-between items-start mb-3">
      <div className={`font-medium ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
        {item.query}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => _onFollowUp(item.query, item.timestamp)}
          className="text-blue-500 hover:text-blue-600"
          title="Follow up on this query"
        >
          <Share size={16} />
        </button>
        <button
          onClick={() => _onDelete(item.timestamp)}
          className="text-red-500 hover:text-red-600"
          title="Delete this query"
        >
          <Trash size={16} />
        </button>
      </div>
    </div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {Object.entries(item.responses).map(([llm, response]) => (
        <div key={llm} className={`p-3 rounded border ${
          isDarkMode 
            ? 'bg-gray-700 border-gray-600' 
            : 'bg-gray-50 border-gray-200'
        }`}>
          <div className="flex justify-between items-center mb-2">
            <div className={`font-semibold ${
              isDarkMode ? 'text-gray-300' : 'text-gray-700'
            }`}>
              {llm.charAt(0).toUpperCase() + llm.slice(1)}
            </div>
            <ResponseActions
              response={response}
              llmName={llm.charAt(0).toUpperCase() + llm.slice(1)}
              isDarkMode={isDarkMode}
            />
          </div>
          <div className={`text-base whitespace-pre-wrap font-normal leading-relaxed ${
            isDarkMode ? 'text-gray-300' : 'text-gray-600'
          }`} style={{ fontSize: `${textSize - 2}px` }}>
            <div className="space-y-2">
              {response.split('\n\n').map((paragraph, index) => {
                if (paragraph.startsWith('💠')) {
                  return (
                    <h1 key={index} className={`text-lg font-bold mb-3 ${
                      isDarkMode ? 'text-blue-400' : 'text-blue-600'
                    }`} style={{ fontSize: `${(textSize - 2) * 1.25}px` }}>
                      {paragraph}
                    </h1>
                  );
                } else if (paragraph.startsWith('🔷')) {
                  return (
                    <h2 key={index} className={`text-base font-semibold mb-2 ${
                      isDarkMode ? 'text-blue-300' : 'text-blue-500'
                    }`} style={{ fontSize: `${(textSize - 2) * 1.15}px` }}>
                      {paragraph}
                    </h2>
                  );
                } else if (paragraph.startsWith('🔹')) {
                  return (
                    <h3 key={index} className={`text-sm font-medium mb-2 ${
                      isDarkMode ? 'text-blue-200' : 'text-blue-400'
                    }`} style={{ fontSize: `${(textSize - 2) * 1.1}px` }}>
                      {paragraph}
                    </h3>
                  );
                } else if (paragraph.startsWith('•') || paragraph.startsWith('📍')) {
                  return (
                    <div key={index} className="pl-3 mb-2 text-sm">
                      {paragraph}
                    </div>
                  );
                } else if (paragraph.startsWith('📝')) {
                  return (
                    <div key={index} className={`p-2 rounded-md mb-2 text-sm ${
                      isDarkMode ? 'bg-gray-600' : 'bg-gray-100'
                    }`}>
                      {paragraph}
                    </div>
                  );
                }
                return <p key={index} className="mb-2" style={{ fontSize: `${textSize - 2}px` }}>{paragraph}</p>;
              })}
            </div>
          </div>
        </div>
      ))}
    </div>
    <div className={`flex justify-end text-xs mt-2 ${
      isDarkMode ? 'text-gray-500' : 'text-gray-400'
    }`}>
      {new Date(item.timestamp).toLocaleString()}
    </div>
  </div>
);

const LLMComparisonPlatform = () => {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme');
      return saved ? saved === 'dark' : true;
    }
    return true;
  });

  const [textSize, setTextSize] = useState(16); // Default text size
  const [apiSearchQuery, _setApiSearchQuery] = useState(''); // New state for API search

  useEffect(() => {
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  const handleZoomIn = () => {
    setTextSize((prevSize) => Math.min(prevSize + 2, 32)); // Max size 32px
  };

  const handleZoomOut = () => {
    setTextSize((prevSize) => Math.max(prevSize - 2, 12)); // Min size 12px
  };

  const [query, setQuery] = useState('');
  const [_results, setResults] = useState<Results>({
    perplexity: '',
    chatgpt: '',
    gemini: ''
  });
  const [error, setError] = useState<string | null>(null);
  const [_fileName, setFileName] = useState<string>('');
  const [_fileContent, setFileContent] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedQuery, setSelectedQuery] = useState<number | null>(null);
  const [userType, setUserType] = useState<string | null>(null);
  const [queryType, setQueryType] = useState<string | null>(null);
  const [, _setSelectedUserType] = useState<string | null>(null);
  const [, _setSelectedQueryType] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [_loading, setLoading] = useState<boolean>(true);
  const [isSearching, setIsSearching] = useState<boolean>(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  };

  // Add pagination constants and state
  const ITEMS_PER_PAGE = 5;
  const [currentPage, _setCurrentPage] = useState(1);
  const [queryHistory, setQueryHistory] = useState<QueryResponse[]>([]);

  // Add pagination calculation
  const totalPages = Math.ceil(queryHistory.length / ITEMS_PER_PAGE);
  const currentQueries = queryHistory.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );  

  // Handle Firebase auth state changes
  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      setUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
      toast.success('Signed out successfully');
    } catch (error) {
      console.error('Logout error:', error);
      toast.error('Failed to sign out');
    }
  };

  // API calling functions
  const callOpenAI = async (prompt: string) => {
    try {
      // Add formatting instructions to the prompt
      const formattedPrompt = `You are an expert at providing tailored responses based on user type and query type.
User Type: ${userType || 'general user'}
Query Type: ${queryType || 'general query'}

Please format your response using the following structure:
# Main points as top-level headings
## Important details as subheadings
### Additional information as smaller headings
- Use bullet points for lists
1. Use numbered lists for steps
> Use blockquotes for important notes

Your response:
${prompt}`;

      const response = await timeoutPromise(
        fetch(`${API_CONFIG.openai.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.NEXT_PUBLIC_OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: API_CONFIG.openai.model,
            messages: [{ role: 'user', content: formattedPrompt }],
            temperature: 0.7,
            max_tokens: 2048
          })
        }),
        30000
      );
      
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorBody}`);
      }
      
      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      console.error('OpenAI API Error:', error);
      return `Error (OpenAI): ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  };
  const callGemini = async (prompt: string) => {
    try {
      // Add formatting instructions to the prompt
      const formattedPrompt = `You are an expert at providing tailored responses based on user type and query type.
User Type: ${userType || 'general user'}
Query Type: ${queryType || 'general query'}

Please format your response using the following structure:
# Main points as top-level headings
## Important details as subheadings
### Additional information as smaller headings
- Use bullet points for lists
1. Use numbered lists for steps
> Use blockquotes for important notes

Your response:
${prompt}`;

      if (!API_CONFIG.gemini.apiKey) {
        throw new Error('Gemini API key not found');
      }

      const response = await fetch(
        `${API_CONFIG.gemini.baseUrl}/models/${API_CONFIG.gemini.model}:generateContent?key=${API_CONFIG.gemini.apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: formattedPrompt }]
            }]
          })
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data.candidates[0].content.parts[0].text;
    } catch (error) {
      return `Error (Gemini): ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  };

  const callPerplexity = async (prompt: string) => {
    try {
      // Add formatting instructions to the prompt
      const formattedPrompt = `You are an expert at providing tailored responses based on user type and query type.
User Type: ${userType || 'general user'}
Query Type: ${queryType || 'general query'}

Please format your response using the following structure:
# Main points as top-level headings
## Important details as subheadings
### Additional information as smaller headings
- Use bullet points for lists
1. Use numbered lists for steps
> Use blockquotes for important notes

Your response:
${prompt}`;

      if (!API_CONFIG.perplexity.apiKey) {
        throw new Error('Perplexity API key not found');
      }

      const response = await fetch(`${API_CONFIG.perplexity.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_CONFIG.perplexity.apiKey}`
        },
        body: JSON.stringify({
          model: API_CONFIG.perplexity.model,
          messages: [{ role: 'user', content: formattedPrompt }],
          max_tokens: 1024,
          temperature: 0.7,
          stream: false
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Perplexity API Error Response:', errorText);
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
      }

      const data = await response.json();
      console.log('Perplexity API Response:', JSON.stringify(data, null, 2));

      // Extract content 
      const content = data.choices[0].message.content;

      return content;
    } catch (error) {
      console.error('Detailed Perplexity Error:', error);
      return `Error (Perplexity): ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  };

  // Load user's history when they log in
  useEffect(() => {
    const loadUserHistory = async () => {
      if (user) {
        const history = await getUserHistory(user.uid);
        setQueryHistory(history);
      }
    };
    loadUserHistory();
  }, [user]);

  // Function to get user's query history
  const getUserHistory = async (userId: string) => {
    try {
      const q = firestoreQuery(
        collection(db, 'queries'),
        where('userId', '==', userId),
        orderBy('timestamp', 'desc'),
        limit(ITEMS_PER_PAGE * 2) // Fetch enough for pagination
      );
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          query: data.query,
          timestamp: data.timestamp,
          parentId: data.parentId,
          responses: data.responses as Results
        } as QueryResponse;
      });
    } catch (error) {
      console.error('Error fetching user history:', error);
      return [];
    }
  };

  // Function to store query and responses
  const storeQueryAndResponses = async (
    userId: string,
    query: string,
    responses: Results,
    userType: string | null,
    queryType: string | null
  ) => {
    try {
      await addDoc(collection(db, 'queries'), {
        userId,
        query,
        responses,
        userType,
        queryType,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error storing query:', error);
    }
  };

  // Add or update the standardizeResponse function
  const standardizeResponse = (text: string): string => {
    if (!text) return '';
    
    // First, clean up any existing formatting
    let formatted = text
      .trim()
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');

    // Handle code blocks first (to prevent interference with other formatting)
    formatted = formatted.replace(/```[a-z]*\n([\s\S]*?)```/g, '「$1」');

    // Format markdown headers with custom styling
    formatted = formatted
      .replace(/^### ?(.*$)/gm, '🔹 $1') // Small headings
      .replace(/^## ?(.*$)/gm, '🔷 $1')  // Medium headings
      .replace(/^# ?(.*$)/gm, '💠 $1');   // Large headings

    // Format lists more consistently
    formatted = formatted
      .replace(/^\* ?(.*$)/gm, '• $1')    // Convert * to bullet points
      .replace(/^- ?(.*$)/gm, '• $1')     // Convert - to bullet points
      .replace(/^(\d+)\. ?(.*$)/gm, '📍 $1. $2'); // Add emoji to numbered points

    // Format quotes and important sections
    formatted = formatted
      .replace(/^> ?(.*$)/gm, '📝 $1')    // Quotes/Notes
      .replace(/`([^`]+)`/g, '「$1」');    // Inline code

    // Handle bold and italic text
    formatted = formatted
      .replace(/\*\*([^*]+)\*\*/g, '$1')  // Bold
      .replace(/__([^_]+)__/g, '$1')      // Bold with underscore
      .replace(/\*([^*]+)\*/g, '$1')      // Italic
      .replace(/_([^_]+)_/g, '$1');       // Italic with underscore

    // Clean up links
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

    // Ensure consistent spacing between sections
    formatted = formatted
      .split('\n')
      .map(line => line.trim())
      .filter(line => line)
      .join('\n\n');

    return formatted;
  };

  const handleSearch = async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (!query.trim()) return;

    setIsSearching(true);

    const parentQuery = selectedQuery
      ? queryHistory.find(q => q.timestamp === selectedQuery)
      : undefined;

    // Include user context in the prompt
    let contextualPrompt = `User Type: ${userType || 'Not specified'}\nQuery Type: ${queryType || 'Not specified'}\n\n`;
    
    if (parentQuery) {
      contextualPrompt += createPromptWithContext(query, parentQuery);
    } else {
      contextualPrompt += query;
    }

    const newQuery = {
      query: query.trim(),
      timestamp: Date.now(),
      parentId: parentQuery?.timestamp,
      responses: {
        perplexity: 'Loading...',
        chatgpt: 'Loading...',
        gemini: 'Loading...'
      }
    };

    // Preserve existing history and add new query at the beginning
    setQueryHistory(prev => [newQuery, ...prev]);

    try {
      const openaiPromise = callOpenAI(contextualPrompt);
      const perplexityPromise = callPerplexity(contextualPrompt);
      const geminiPromise = callGemini(contextualPrompt);

      // Optimistically update the query history with loading states
      setQueryHistory(prev => prev.map(q =>
        q.timestamp === newQuery.timestamp
          ? {
              ...q,
              responses: {
                chatgpt: 'Loading...',
                perplexity: 'Loading...',
                gemini: 'Loading...'
              }
            }
          : q
      ));

      // Define a function to update the response for a specific LLM
      const updateResponse = async (llm: string, promise: Promise<string>) => {
        try {
          const result = await promise;
          setQueryHistory(prev => prev.map(q =>
            q.timestamp === newQuery.timestamp
              ? {
                  ...q,
                  responses: {
                    ...q.responses,
                    [llm]: standardizeResponse(result)
                  }
                }
              : q
          ));
        } catch (error) {
          console.error(`${llm} API Error:`, error);
          setQueryHistory(prev => prev.map(q =>
            q.timestamp === newQuery.timestamp
              ? {
                  ...q,
                  responses: {
                    ...q.responses,
                    [llm]: `Error (${llm}): ${error instanceof Error ? error.message : 'Unknown error'}`
                  }
                }
              : q
          ));
        }
      };

      // Call the updateResponse function for each LLM
      updateResponse('chatgpt', openaiPromise);
      updateResponse('perplexity', perplexityPromise);
      updateResponse('gemini', geminiPromise);

      // Store in Firebase if user is logged in
      if (user) {
        Promise.all([openaiPromise, perplexityPromise, geminiPromise])
          .then(async ([chatgpt, perplexity, gemini]) => {
            const finalResponses = {
              chatgpt: standardizeResponse(chatgpt),
              perplexity: standardizeResponse(perplexity),
              gemini: standardizeResponse(gemini)
            };
            await storeQueryAndResponses(user.uid, query.trim(), finalResponses, userType, queryType);
          })
          .catch(error => {
            console.error('Error storing responses in Firebase:', error);
          });
      }
    } catch (error) {
      console.error('Search error:', error);
      setError('Some responses failed to load. Check individual results.');
    } finally {
      setIsSearching(false);
    }
  };

  // Add file handling functions
  const readFileContent = async (file: File): Promise<string> => {
    try {
      const fileType = Object.entries(SUPPORTED_FILE_TYPES).find(([mimeType, config]) => {
        return config.extensions.some(ext => file.name.toLowerCase().endsWith(ext)) ||
               file.type === mimeType;
      });

      if (!fileType) {
        throw new Error('Unsupported file type');
      }

      return await fileType[1].process(file);
    } catch (error) {
      throw new Error(`Error processing file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setError(null);

    try {
      const content = await readFileContent(file);
      if (content.length > 50000) {
        throw new Error('File content is too large. Please upload a smaller file.');
      }
      setFileContent(content);
      setQuery(content);
    } catch (error) {
      setFileName('');
      setFileContent('');
      setError(error instanceof Error ? error.message : 'Error reading file. Please try again.');
      console.error('File reading error:', error);
    }
  };

  const handleFileButtonClick = () => {
    fileInputRef.current?.click();
  };

  // Get accepted file types
  const acceptedFileTypes = Object.values(SUPPORTED_FILE_TYPES)
    .flatMap(type => type.extensions)
    .join(',');

  // Add theme persistence
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      setIsDarkMode(savedTheme === 'dark');
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  // Add new functions to handle history interactions
  const handleFollowUp = (query: string, timestamp: number) => {
    setQuery(`Following up on: "${query}"\n\nMy question: `);
    setSelectedQuery(timestamp);
  };

  const handleDeleteQuery = (timestamp: number) => {
    setQueryHistory(prev => prev.filter(item => item.timestamp !== timestamp));
    // If user is logged in, you might want to delete from Firebase as well
    if (user) {
      // Add Firebase delete logic here
    }
  };

  // Function to create prompt with context
  const createPromptWithContext = (prompt: string, parentQuery?: QueryResponse) => {
    if (!parentQuery) return prompt;
    return `Previous question: ${parentQuery.query}\nPrevious answers:\nChatGPT: ${parentQuery.responses.chatgpt}\nGemini: ${parentQuery.responses.gemini}\nPerplexity: ${parentQuery.responses.perplexity}\n\nFollow-up question: ${prompt}`;
  };

  return (
    <div className={`min-h-screen ${isDarkMode ? 'bg-black text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* Fixed Header */}
      <header className={`${isDarkMode ? 'bg-gray-900' : 'bg-white shadow-sm'} sticky top-0 z-10`}>
        <div className="max-w-auto mx-auto p-1 space-y-0">
          {/* Top Row */}
          <div className="flex items-center gap-20 justify-between">
            {/* Logo and Title */}
            <div className="flex items-center">
              <Image src="/logo.svg" alt="3LLMs Logo" width={95} height={40} priority />
              <h1 className="text-2xl font-bold ml-4"></h1>
            </div>
            
            {/* Search Bar */}
            <div className="relative flex-1 max-w-3xl mx-auto ml-60">
              <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 ${
                isDarkMode ? 'text-gray-600' : 'text-gray-400'
              }`} size={19} />
              <form onSubmit={handleSearch} className="w-xl">
                <textarea
                  ref={textareaRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Enter your query..."
                  className={`w-full pl-10 pr-4 py-2 rounded-lg border ${
                    isDarkMode 
                      ? 'border-gray-700 bg-gray-900 text-white' 
                      : 'border-gray-300 bg-white text-gray-900'
                  } focus:outline-none focus:ring-2 focus:ring-blue-500`}
                  rows={1} // Adjust the initial number of rows as needed
                  style={{ resize: 'none', maxHeight: '100px', overflowY: 'auto' }} // Set maxHeight and enable vertical scrolling
                />
              </form>
            </div>

            {/* Upload Button */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              className="hidden"
              accept={acceptedFileTypes}
            />
            <button
              type="button"
              onClick={handleFileButtonClick}
              className="p-2 bg-gray-800 text-gray-400 rounded-lg hover:bg-gray-700"
              title="Upload File"
            >
              <Upload size={20} />
            </button>

            {/* Right Side Controls */}
            <div className="flex flex-col items-end gap-2">
              {/* Auth and Controls Row */}
              <div className="flex items-center gap-2">
                {user ? (
                  <button onClick={handleLogout} className={`px-3 py-1 rounded-lg ${
                    isDarkMode
                      ? 'bg-red-600 text-white hover:bg-red-700'
                      : 'bg-red-500 text-white hover:bg-red-600'
                  }`}>
                    Logout
                  </button>
                ) : (
                  <Login />
                )}
                <ThemeToggle isDarkMode={isDarkMode} setIsDarkMode={setIsDarkMode} />
                <button onClick={handleZoomIn} className={`p-2 rounded-lg ${
                  isDarkMode
                    ? 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
                }`} title="Zoom In">A+</button>
                <button onClick={handleZoomOut} className={`p-2 rounded-lg ${
                  isDarkMode
                    ? 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
                }`} title="Zoom Out">A-</button>
              </div>
            </div>
          </div>

          {/* Bottom Row - Type Buttons and Pagination Controls */}
          <div className="flex justify-center items-center gap-4 mt-2 justify-center">
            {/* User Type Buttons */}
            <div className="flex gap-1">
              {['Student', 'Employee', 'Business'].map((type) => (
                <button
                  key={type}
                  onClick={() => {
                    setUserType(userType === type ? null : type);
                    _setSelectedUserType(userType === type ? null : type);
                  }}
                  className={`px-2 py-1 rounded-md text-m ${
                    userType === type
                      ? 'bg-blue-600 text-white'
                      : isDarkMode
                        ? 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
                  }`}
                  type="button"
                >
                  {type}
                </button>
              ))}
            </div>

            {/* Query Type Buttons */}
            <div className="flex gap-1 justify-center">
              {['Shopping', 'Financial', 'Travel'].map((type) => (
                <button
                  key={type}
                  onClick={() => {
                    setQueryType(queryType === type ? null : type);
                    _setSelectedQueryType(queryType === type ? null : type);
                  }}
                  className={`px-2 py-1 rounded-md text-m ${ // Changed text-m to text-sm
                    queryType === type
                      ? 'bg-blue-600 text-white'
                      : isDarkMode
                        ? 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
                  }`}
                  type="button"
                >
                  {type}
                </button>
              ))}
            </div>

            
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="pt-0">
        <Toaster position="top-center" reverseOrder={false} />
        <div className="mx-auto space-y-2">
          {/* Error Message */}
          {error && (
            <div className="max-w-2xl mx-auto mt-2 p-2 bg-red-900 text-red-400 rounded-lg">
              {error}
            </div>
          )}

          {/* Fixed Results Grid with minimal gap */}
          <div className={`grid grid-cols-1 md:grid-cols-3 gap-1 mt-6 ${
            isDarkMode ? 'bg-black' : 'bg-gray-50'
          }`}>
            {LLM_CONFIG.map(llm => {
              const response = currentQueries[0]?.responses?.[llm.id as keyof Results];
              if (apiSearchQuery && response && !response.toLowerCase().includes(apiSearchQuery.toLowerCase())) {
                return null;
              }
              return (
                <ResultTile
                  key={llm.id}
                  llm={llm}
                  response={response}
                  isLoading={isSearching && !!query}
                  onFollowUp={(text) => {
                    setQuery(`Following up on: ${text}\n\nMy question: `);
                    setSelectedQuery(currentQueries[0]?.timestamp || null);
                  }}
                  isDarkMode={isDarkMode}
                  textSize={textSize}  // Pass the textSize prop
                />
              );
            })}
          </div>

          {/* Previous Query History */}
          <div className="space-y-6 mt-6">
            {currentQueries.slice(1).map((item) => (
              <ChatHistoryItem
                key={item.timestamp}
                item={item}
                isDarkMode={isDarkMode}
                onFollowUp={handleFollowUp}
                onDelete={handleDeleteQuery}
                textSize={textSize}  // Pass the textSize prop
              />
            ))}
          </div>

          {/* Page Information */}
          {queryHistory.length > 0 && (
            <div className="flex justify-center mt-4">
              <span className={`text-sm ${
                isDarkMode ? 'text-gray-400' : 'text-gray-600'
              }`}>
                Page {currentPage} of {totalPages}
              </span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};


export default LLMComparisonPlatform;
